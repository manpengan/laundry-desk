import { createCipheriv, createDecipheriv, createHash, pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { fail } from "./companion-contract.mjs";

// Same cryptographic construction as RuntimePortableArchive.swift; distinct
// magic because the Windows logical-data payload is not the macOS dump format.
export const PORTABLE_CHUNK_BYTES = 1024 * 1024;
export const MAX_PORTABLE_PLAIN_BYTES = 3 * 1024 * 1024 * 1024;
export const PORTABLE_HEADER_BYTES = 56;
const MAGIC = Buffer.from("LDWXFER1");
const ROUNDS = 600_000;
const derive = promisify(pbkdf2);

export function requirePortablePassword(password) {
  if (!Buffer.isBuffer(password) || password.length < 12 || password.length > 256)
    fail("PORTABLE_PASSWORD_INVALID");
}

function countFor(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PORTABLE_PLAIN_BYTES)
    fail("PORTABLE_INVALID");
  return Math.ceil(size / PORTABLE_CHUNK_BYTES);
}

export function portableArchiveBytes(size) {
  return PORTABLE_HEADER_BYTES + size + countFor(size) * 20;
}

function headerFor(size) {
  const header = Buffer.alloc(PORTABLE_HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt16BE(1, 8);
  header[10] = 1;
  header[11] = 1;
  header.writeUInt32BE(ROUNDS, 12);
  randomBytes(16).copy(header, 16);
  randomBytes(4).copy(header, 32);
  header.writeUInt32BE(PORTABLE_CHUNK_BYTES, 36);
  header.writeBigUInt64BE(BigInt(size), 40);
  header.writeBigUInt64BE(BigInt(countFor(size)), 48);
  return header;
}

function decodeHeader(header) {
  const size = Number(header.readBigUInt64BE(40));
  const count = Number(header.readBigUInt64BE(48));
  const rounds = header.readUInt32BE(12);
  if (
    !header.subarray(0, 8).equals(MAGIC) ||
    header.readUInt16BE(8) !== 1 ||
    header[10] !== 1 ||
    header[11] !== 1 ||
    rounds < ROUNDS ||
    rounds > 5_000_000 ||
    header.readUInt32BE(36) !== PORTABLE_CHUNK_BYTES ||
    count !== countFor(size)
  )
    fail("PORTABLE_INVALID");
  return { size, count, rounds };
}

async function readExactly(source, count) {
  const chunks = [];
  let size = 0;
  while (size < count) {
    const bytes = await source(count - size);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > count - size)
      fail("PORTABLE_INVALID");
    chunks.push(bytes);
    size += bytes.length;
  }
  return Buffer.concat(chunks, count);
}

function nonceAndAad(header, index, record) {
  const sequence = Buffer.alloc(8);
  sequence.writeBigUInt64BE(BigInt(index));
  return {
    nonce: Buffer.concat([header.subarray(32, 36), sequence]),
    aad: Buffer.concat([header, sequence, record]),
  };
}

export async function encryptPortable(source, size, password, output) {
  requirePortablePassword(password);
  const header = headerFor(size);
  const count = countFor(size);
  const key = await derive(password, header.subarray(16, 32), ROUNDS, 32, "sha256");
  const hash = createHash("sha256");
  const write = async (bytes) => {
    await output.writeFile(bytes);
    hash.update(bytes);
  };
  try {
    await write(header);
    for (let index = 0; index < count; index++) {
      const length = Math.min(PORTABLE_CHUNK_BYTES, size - index * PORTABLE_CHUNK_BYTES);
      const plain = await readExactly(source, length);
      const record = Buffer.alloc(4);
      record.writeUInt32BE(length);
      const { nonce, aad } = nonceAndAad(header, index, record);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      plain.fill(0);
      await write(record);
      await write(encrypted);
      await write(cipher.getAuthTag());
    }
    if ((await source(1)).length !== 0) fail("PORTABLE_SOURCE_CHANGED");
    await output.sync();
    return { size: portableArchiveBytes(size), sha256: hash.digest("hex") };
  } finally {
    key.fill(0);
  }
}

export async function decryptPortable(source, password, sink, preflight = async () => {}) {
  requirePortablePassword(password);
  const header = await readExactly(source, PORTABLE_HEADER_BYTES);
  const { size, count, rounds } = decodeHeader(header);
  await preflight({ plaintext_bytes: size, archive_bytes: portableArchiveBytes(size) });
  const key = await derive(password, header.subarray(16, 32), rounds, 32, "sha256");
  const hash = createHash("sha256").update(header);
  try {
    for (let index = 0; index < count; index++) {
      const length = Math.min(PORTABLE_CHUNK_BYTES, size - index * PORTABLE_CHUNK_BYTES);
      const record = await readExactly(source, 4);
      if (record.readUInt32BE() !== length) fail("PORTABLE_INVALID");
      const encrypted = await readExactly(source, length);
      const tag = await readExactly(source, 16);
      const { nonce, aad } = nonceAndAad(header, index, record);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      let plain;
      try {
        plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      } catch {
        fail("PORTABLE_INVALID");
      }
      try {
        await sink(plain);
      } finally {
        plain.fill(0);
      }
      hash.update(record).update(encrypted).update(tag);
    }
    if ((await source(1)).length !== 0) fail("PORTABLE_INVALID");
    return { size: portableArchiveBytes(size), sha256: hash.digest("hex") };
  } finally {
    key.fill(0);
  }
}

export function handleSource(handle) {
  let position = 0;
  return async (maximum) => {
    const bytes = Buffer.alloc(maximum);
    const { bytesRead } = await handle.read(bytes, 0, maximum, position);
    position += bytesRead;
    return bytes.subarray(0, bytesRead);
  };
}
