import { sign, verify } from "node:crypto";

export const LEASE_SIGNATURE_DOMAIN = "laundry.primary-lease.v1";
export const RELEASE_SIGNATURE_DOMAIN = "laundry.primary-lease-release.v1";

function leaseAuthorityFields(lease) {
  return {
    lease_id: lease.lease_id,
    store_id: lease.store_id,
    device_id: lease.device_id,
    primary_epoch: lease.primary_epoch,
    issued_at: lease.issued_at,
    ttl_ms: lease.ttl_ms,
    max_clock_skew_ms: lease.max_clock_skew_ms,
    not_after: lease.not_after,
  };
}

function releaseAuthorityFields(ack) {
  return {
    lease_id: ack.lease_id,
    device_id: ack.device_id,
    primary_epoch: ack.primary_epoch,
    nonce: ack.nonce,
  };
}

function canonicalMessage(domain, value) {
  return `${domain}\n${JSON.stringify(value)}`;
}

function canonicalBytes(domain, value) {
  return Buffer.from(canonicalMessage(domain, value), "utf8");
}

export function canonicalLeaseMessage(lease) {
  return canonicalMessage(LEASE_SIGNATURE_DOMAIN, leaseAuthorityFields(lease));
}

export function createLeaseSigner({ privateKey, publicKey }) {
  return Object.freeze({
    sign(payload) {
      const authority = leaseAuthorityFields(payload);
      const sig = sign(
        null,
        canonicalBytes(LEASE_SIGNATURE_DOMAIN, authority),
        privateKey,
      ).toString("base64url");
      return Object.freeze({ ...authority, sig });
    },
    verify(signedLease) {
      const authority = leaseAuthorityFields(signedLease);
      return verify(
        null,
        canonicalBytes(LEASE_SIGNATURE_DOMAIN, authority),
        publicKey,
        Buffer.from(signedLease.sig, "base64url"),
      );
    },
  });
}

export function createReleaseAck(input) {
  const authority = releaseAuthorityFields(input);
  const sig = sign(
    null,
    canonicalBytes(RELEASE_SIGNATURE_DOMAIN, authority),
    input.privateKey,
  ).toString("base64url");
  return Object.freeze({ ...authority, sig });
}

export function verifyReleaseAck(ack, publicKey) {
  if (!publicKey) return false;
  return verify(
    null,
    canonicalBytes(RELEASE_SIGNATURE_DOMAIN, releaseAuthorityFields(ack)),
    publicKey,
    Buffer.from(ack.sig, "base64url"),
  );
}
