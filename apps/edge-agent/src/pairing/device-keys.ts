/**
 * D2 device keypair port (Ed25519).
 *
 * Production adapter MUST persist the private key only in the OS credential
 * store (Windows DPAPI / macOS Keychain via keytar or equivalent). Private
 * keys must never enter renderer, preload, SQLite, settings JSON, or logs.
 *
 * This module ships MemoryDeviceKeyStore for unit tests and an explicit
 * UnimplementedOsDeviceKeyStore stub — do not wire native keytar here if it
 * would break CI without platform secrets APIs.
 */
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export const DEVICE_KEY_ALGORITHM = "Ed25519" as const;

export type DevicePublicKeyExport = Readonly<{
  algorithm: typeof DEVICE_KEY_ALGORITHM;
  /** SPKI DER, unpadded base64url — safe to register with the server. */
  publicKeySpkiBase64Url: string;
}>;

export type DeviceKeyMaterial = Readonly<{
  publicKey: KeyObject;
  privateKey: KeyObject;
  exportPublic(): DevicePublicKeyExport;
  signBytes(message: Uint8Array): Uint8Array;
}>;

/**
 * Persistence port for the device signing keypair.
 * Implementations must never expose raw private key bytes over IPC.
 */
export interface DeviceKeyStore {
  /** Create a new keypair, replacing any existing material. */
  generate(): DeviceKeyMaterial;
  /** Load existing material, or null when unpaired. */
  load(): DeviceKeyMaterial | null;
  /** Best-effort erase on unbind. */
  clear(): void;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function base64UrlToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function exportPublicKeySpkiBase64Url(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "der" }).toString("base64url");
}

export function importPublicKeySpkiBase64Url(spkiBase64Url: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(spkiBase64Url, "base64url"),
    format: "der",
    type: "spki",
  });
}

function wrapMaterial(publicKey: KeyObject, privateKey: KeyObject): DeviceKeyMaterial {
  return Object.freeze({
    publicKey,
    privateKey,
    exportPublic(): DevicePublicKeyExport {
      return Object.freeze({
        algorithm: DEVICE_KEY_ALGORITHM,
        publicKeySpkiBase64Url: exportPublicKeySpkiBase64Url(publicKey),
      });
    },
    signBytes(message: Uint8Array): Uint8Array {
      return new Uint8Array(sign(null, message, privateKey));
    },
  });
}

export function generateEd25519Material(): DeviceKeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return wrapMaterial(publicKey, privateKey);
}

/** In-memory store for tests and ephemeral local dev only. */
export class MemoryDeviceKeyStore implements DeviceKeyStore {
  private material: DeviceKeyMaterial | null = null;

  generate(): DeviceKeyMaterial {
    this.material = generateEd25519Material();
    return this.material;
  }

  load(): DeviceKeyMaterial | null {
    return this.material;
  }

  clear(): void {
    this.material = null;
  }
}

/**
 * Production placeholder. Wire keytar/DPAPI behind this port in a later PR;
 * intentionally throws so CI never depends on native credential APIs.
 */
export class UnimplementedOsDeviceKeyStore implements DeviceKeyStore {
  generate(): DeviceKeyMaterial {
    throw new Error(
      "OsDeviceKeyStore not implemented: persist Ed25519 private key via keytar/DPAPI",
    );
  }

  load(): DeviceKeyMaterial | null {
    throw new Error("OsDeviceKeyStore not implemented: load Ed25519 private key via keytar/DPAPI");
  }

  clear(): void {
    throw new Error("OsDeviceKeyStore not implemented: clear Ed25519 private key via keytar/DPAPI");
  }
}
