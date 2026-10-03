import assert from "node:assert/strict";
import test from "node:test";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backupFixture } from "./backup-test-fixture.mjs";
import {
  encryptPortable,
  decryptPortable,
  handleSource,
  PORTABLE_CHUNK_BYTES,
  portableArchiveBytes,
} from "./portable-crypto.mjs";

const password = Buffer.from("correct horse battery staple");
const source = (bytes) => {
  let position = 0;
  return async (maximum) => {
    const part = bytes.subarray(position, position + maximum);
    position += part.length;
    return part;
  };
};

test("portable AES-GCM streams multiple chunks and binds the complete archive", async (t) => {
  const context = await backupFixture(t);
  const plain = Buffer.alloc(PORTABLE_CHUNK_BYTES * 2 + 17, 71);
  const path = join(context.root, "encrypted.ldbackup");
  const output = await open(path, "wx", 0o600);
  const encrypted = await encryptPortable(source(plain), plain.length, password, output);
  await output.close();
  assert.equal(encrypted.size, portableArchiveBytes(plain.length));
  const input = await open(path);
  const chunks = [];
  const decrypted = await decryptPortable(handleSource(input), password, async (bytes) =>
    chunks.push(Buffer.from(bytes)),
  );
  await input.close();
  assert.deepEqual(Buffer.concat(chunks), plain);
  assert.deepEqual(decrypted, encrypted);
  assert.equal((await readFile(path)).includes(Buffer.from("correct horse")), false);
});

test("wrong password, tampering, truncation and trailing bytes are rejected", async (t) => {
  const context = await backupFixture(t);
  const path = join(context.root, "encrypted.ldbackup");
  const handle = await open(path, "wx", 0o600);
  await encryptPortable(source(Buffer.from("private data")), 12, password, handle);
  await handle.close();
  const original = await readFile(path);
  const changed = Buffer.from(original);
  changed[60] ^= 1;
  for (const [bytes, pass] of [
    [original, Buffer.from("different-password")],
    [changed, password],
    [original.subarray(0, -1), password],
    [Buffer.concat([original, Buffer.from("x")]), password],
  ])
    await assert.rejects(
      decryptPortable(source(bytes), pass, async () => {}),
      /PORTABLE_INVALID/u,
    );
  const invalid = Buffer.from(original);
  invalid.writeUInt32BE(1, 12);
  await assert.rejects(
    decryptPortable(source(invalid), password, async () => {}),
    /PORTABLE_INVALID/u,
  );
  await writeFile(path, original);
});

test("invalid secrets and claimed sizes fail before consuming plaintext", async () => {
  const unused = async () => assert.fail("must not read plaintext");
  await assert.rejects(encryptPortable(unused, 12, Buffer.from("short"), {}), /PASSWORD_INVALID/u);
  await assert.rejects(encryptPortable(unused, 4 * 1024 ** 3, password, {}), /PORTABLE_INVALID/u);
});
