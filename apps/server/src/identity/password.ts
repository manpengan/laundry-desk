/**
 * Password hashing port for C6.
 *
 * Production default: **Argon2id** via `@node-rs/argon2` (PHC string).
 * Parameters sized for Windows counter PCs (login target ~300ms on low-end SKUs):
 *   memoryCost: 19_456 KiB (~19 MiB)
 *   timeCost: 2
 *   parallelism: 1
 *
 * Verify still accepts legacy `scrypt$…` hashes for expand-only migration.
 * Unit tests may use `createTestPasswordPort` (no crypto cost).
 */

import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

/** Argon2id algorithm id from @node-rs/argon2 (avoid ambient const enum under isolatedModules). */
const ARGON2ID_ALGORITHM = 2;

type ScryptOptions = Readonly<{ N: number; r: number; p: number }>;

const scryptAsync = (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey as Buffer);
    });
  });

/** Portable hash / verify interface — Argon2 or scrypt adapters plug in here. */
export type PasswordPort = Readonly<{
  hashPassword: (password: string) => Promise<string>;
  verifyPassword: (password: string, storedHash: string) => Promise<boolean>;
}>;

/** Documented Argon2id defaults (KiB / iterations / lanes). */
export const ARGON2ID_DEFAULTS = Object.freeze({
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  algorithm: ARGON2ID_ALGORITHM,
});

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_PREFIX = "scrypt";
const ARGON2_PREFIX = "$argon2";

const encode = (buf: Buffer): string => buf.toString("base64url");
const decode = (value: string): Buffer => Buffer.from(value, "base64url");

const assertPasswordLength = (password: string): void => {
  if (password.length === 0 || password.length > 1_024) {
    throw new RangeError("password length out of bounds");
  }
};

/**
 * scrypt PasswordPort (legacy). Format: scrypt$N$r$p$salt_b64url$key_b64url
 * Kept for verify fallback and offline unit tests without native argon2.
 */
export const createScryptPasswordPort = (): PasswordPort => {
  const hashPassword = async (password: string): Promise<string> => {
    assertPasswordLength(password);
    const salt = randomBytes(SCRYPT_SALT_BYTES);
    const key = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return `${SCRYPT_PREFIX}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${encode(salt)}$${encode(key)}`;
  };

  const verifyPassword = async (password: string, storedHash: string): Promise<boolean> => {
    const parts = storedHash.split("$");
    if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const saltB64 = parts[4];
    const keyB64 = parts[5];
    if (
      !Number.isInteger(n) ||
      !Number.isInteger(r) ||
      !Number.isInteger(p) ||
      saltB64 === undefined ||
      keyB64 === undefined
    ) {
      return false;
    }
    try {
      const salt = decode(saltB64);
      const expected = decode(keyB64);
      const actual = await scryptAsync(password, salt, expected.length, {
        N: n,
        r,
        p,
      });
      if (actual.length !== expected.length) return false;
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  };

  return Object.freeze({ hashPassword, verifyPassword });
};

/**
 * Argon2id PasswordPort (PHC). Format: $argon2id$v=19$m=…,t=…,p=…$…
 */
export const createArgon2idPasswordPort = (): PasswordPort => {
  const hashPassword = async (password: string): Promise<string> => {
    assertPasswordLength(password);
    return argon2Hash(password, {
      memoryCost: ARGON2ID_DEFAULTS.memoryCost,
      timeCost: ARGON2ID_DEFAULTS.timeCost,
      parallelism: ARGON2ID_DEFAULTS.parallelism,
      algorithm: ARGON2ID_DEFAULTS.algorithm,
    });
  };

  const verifyPassword = async (password: string, storedHash: string): Promise<boolean> => {
    if (!storedHash.startsWith(ARGON2_PREFIX)) return false;
    try {
      return await argon2Verify(storedHash, password);
    } catch {
      return false;
    }
  };

  return Object.freeze({ hashPassword, verifyPassword });
};

/**
 * Production port: hash with Argon2id; verify Argon2id or legacy scrypt.
 */
export const createPasswordPort = (): PasswordPort => {
  const argon = createArgon2idPasswordPort();
  const scrypt = createScryptPasswordPort();

  return Object.freeze({
    hashPassword: (password: string) => argon.hashPassword(password),
    verifyPassword: async (password: string, storedHash: string): Promise<boolean> => {
      if (storedHash.startsWith(ARGON2_PREFIX)) {
        return argon.verifyPassword(password, storedHash);
      }
      if (storedHash.startsWith(`${SCRYPT_PREFIX}$`)) {
        return scrypt.verifyPassword(password, storedHash);
      }
      return false;
    },
  });
};

/**
 * Deterministic test double — not for production.
 * Format: test$base64url(password) so tests stay pure and fast.
 */
export const createTestPasswordPort = (): PasswordPort => {
  const hashPassword = async (password: string): Promise<string> =>
    `test$${Buffer.from(password, "utf8").toString("base64url")}`;

  const verifyPassword = async (password: string, storedHash: string): Promise<boolean> => {
    const expected = await hashPassword(password);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(storedHash, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };

  return Object.freeze({ hashPassword, verifyPassword });
};

/** PIN uses the same port shape (4–8 digit secrets hashed like passwords). */
export type PinPort = PasswordPort;
