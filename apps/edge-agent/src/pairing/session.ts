/**
 * D2 pairing session façade for main-process IPC.
 * Never returns private key material — only public status and one-time codes.
 */
import type { DeviceKeyStore, DevicePublicKeyExport } from "./device-keys.js";
import {
  OneTimePairingCodeService,
  type PairingCodeIssue,
  type PairingCodeStatus,
} from "./one-time-code.js";

export type PairingSessionStatus = Readonly<{
  hasDeviceKey: boolean;
  publicKey: DevicePublicKeyExport | null;
  code: PairingCodeStatus;
}>;

export type PairingCreateCodeResult = Readonly<{
  code: string;
  expiresAtMs: number;
  publicKey: DevicePublicKeyExport;
}>;

export type PairingSession = {
  createCode(nowMs?: number): PairingCreateCodeResult;
  status(nowMs?: number): PairingSessionStatus;
  /** Test / redeem hook — not exposed over IPC. */
  consumeCode(code: string, nowMs?: number): ReturnType<OneTimePairingCodeService["consume"]>;
  readonly keys: DeviceKeyStore;
  readonly codes: OneTimePairingCodeService;
};

/**
 * Ensure a device key exists (generate if missing), issue a 60s code.
 * Replacing the code invalidates the previous unconsumed code.
 */
export function createPairingSession(keys: DeviceKeyStore): PairingSession {
  const codes = new OneTimePairingCodeService();

  const ensureKey = (): DevicePublicKeyExport => {
    const existing = keys.load();
    if (existing !== null) {
      return existing.exportPublic();
    }
    return keys.generate().exportPublic();
  };

  return {
    keys,
    codes,
    createCode(nowMs: number = Date.now()): PairingCreateCodeResult {
      const publicKey = ensureKey();
      const issued: PairingCodeIssue = codes.create(nowMs);
      return Object.freeze({
        code: issued.code,
        expiresAtMs: issued.expiresAtMs,
        publicKey,
      });
    },
    status(nowMs: number = Date.now()): PairingSessionStatus {
      const material = keys.load();
      return Object.freeze({
        hasDeviceKey: material !== null,
        publicKey: material === null ? null : material.exportPublic(),
        code: codes.status(nowMs),
      });
    },
    consumeCode(code: string, nowMs: number = Date.now()) {
      return codes.consume(code, nowMs);
    },
  };
}
