import { z } from "zod";

import { snapshotPlainData } from "./plain-data.js";
import { registerIdentityLifecycleEnvelope, type IdentityLifecycleEnvelope } from "./operations.js";
import { registerBrowserSessionSource } from "./source-registry.js";
import {
  AccessTokenClaimsSchema,
  BrowserCommandViaSchema,
  ServerSessionRecordSchema,
  type BrowserSessionSource,
} from "./session.js";

const VerifiedBrowserSessionInputSchema = z.strictObject({
  via: BrowserCommandViaSchema,
  claims: AccessTokenClaimsSchema,
  session_record: ServerSessionRecordSchema,
});

const MATCHED_SESSION_FIELDS = [
  "session_id",
  "session_version",
  "org_id",
  "store_id",
  "staff_id",
  "device_id",
  "permission_version",
  "authentication_method",
] as const;

/** Restricted C6/C8 authority for one already verified, active browser session. */
export const issueBrowserSessionSource = (input: unknown): BrowserSessionSource => {
  const verified = VerifiedBrowserSessionInputSchema.parse(
    snapshotPlainData(input, "verified browser session"),
  );
  if (verified.session_record.status !== "active") {
    throw new TypeError("Browser session must be active");
  }
  const mismatch = MATCHED_SESSION_FIELDS.find(
    (field) => verified.claims[field] !== verified.session_record[field],
  );
  if (mismatch !== undefined) {
    throw new TypeError(`Browser session ${mismatch} does not match access claims`);
  }

  const source = Object.freeze({
    kind: "browser_session" as const,
    session_id: verified.session_record.session_id,
    session_version: verified.session_record.session_version,
    permission_version: verified.session_record.permission_version,
    authentication_method: verified.session_record.authentication_method,
    actor: Object.freeze({
      staff_id: verified.session_record.staff_id,
      device_id: verified.session_record.device_id,
      via: verified.via,
    }),
    tenant: Object.freeze({
      org_id: verified.session_record.org_id,
      store_id: verified.session_record.store_id,
    }),
  }) as BrowserSessionSource;
  return registerBrowserSessionSource(source);
};

/** Restricted C6/C8 authority for one lifecycle HTTP request after all required gates passed. */
export const issueIdentityLifecycleEnvelope = (input: unknown): IdentityLifecycleEnvelope =>
  registerIdentityLifecycleEnvelope(input);
