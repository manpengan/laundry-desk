import { z } from "zod";
import { win32 } from "node:path";

import { readSecretValue } from "./secret-file.js";

const MINIMUM_SECRET_BYTES = 32;
const LOCAL_PORT = 8787 as const;
const LOCAL_BROWSER_ORIGIN = "http://127.0.0.1:5173" as const;
const LOCAL_HOST_AUTHORITIES = Object.freeze(["127.0.0.1:8787"] as const);
const PRIVATE_IPV4_ORIGIN =
  /^https:\/\/(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}):\d{1,5}$/u;
/**
 * ADR-36 cloud test environment: a registered domain on the default HTTPS port,
 * terminated by a reverse proxy that holds the certificate. Deliberately a
 * separate rule from PRIVATE_IPV4_ORIGIN rather than a widening of it — the
 * LAN profile's private-IPv4 + high-port constraint is load-bearing for ADR-32
 * and must keep rejecting public names.
 */
/* The final label must be alphabetic, which is what separates a domain from a
 * bare IPv4 literal (`https://127.0.0.1` would otherwise match). */
const PUBLIC_HTTPS_ORIGIN =
  /^https:\/\/(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z-]{0,61}[a-z])$/u;

const SecretSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") >= MINIMUM_SECRET_BYTES,
    `must contain at least ${MINIMUM_SECRET_BYTES} UTF-8 bytes`,
  );

const ContainerRuntimeSchema = z
  .string()
  .refine((value) => value === "1", "must equal 1 when set")
  .optional();

const LanOriginSchema = z.preprocess(
  (value) => (typeof value === "string" && value.length === 0 ? undefined : value),
  z
    .string()
    .refine((value) => {
      if (!PRIVATE_IPV4_ORIGIN.test(value)) return false;
      try {
        const parsed = new URL(value);
        const port = Number(parsed.port);
        return (
          parsed.origin === value &&
          parsed.pathname === "/" &&
          parsed.search === "" &&
          parsed.hash === "" &&
          parsed.username === "" &&
          parsed.password === "" &&
          Number.isSafeInteger(port) &&
          port >= 1024 &&
          port <= 65_535
        );
      } catch {
        return false;
      }
    }, "must be an exact HTTPS origin on a private IPv4 address")
    .optional(),
);

const PublicOriginSchema = z.preprocess(
  (value) => (typeof value === "string" && value.length === 0 ? undefined : value),
  z
    .string()
    .refine((value) => {
      if (!PUBLIC_HTTPS_ORIGIN.test(value)) return false;
      try {
        const parsed = new URL(value);
        return (
          parsed.origin === value &&
          parsed.port === "" &&
          parsed.pathname === "/" &&
          parsed.search === "" &&
          parsed.hash === "" &&
          parsed.username === "" &&
          parsed.password === ""
        );
      } catch {
        return false;
      }
    }, "must be an exact HTTPS origin on a public domain at the default port")
    .optional(),
);

const LocalHostEnvironmentSchema = z
  .object({
    LAUNDRY_CONTAINER_RUNTIME: ContainerRuntimeSchema,
    LAUNDRY_LAN_ORIGIN: LanOriginSchema,
    LAUNDRY_PUBLIC_ORIGIN: PublicOriginSchema,
  })
  .superRefine((value, context) => {
    // One server serves one browser origin. Accepting both would leave which of
    // them the cookie and CSRF policy binds to decided by evaluation order.
    if (value.LAUNDRY_LAN_ORIGIN !== undefined && value.LAUNDRY_PUBLIC_ORIGIN !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["LAUNDRY_PUBLIC_ORIGIN"],
        message: "cannot be combined with LAUNDRY_LAN_ORIGIN; a server has one browser origin",
      });
    }
  });

const LocalSigningEnvironmentSchema = z
  .object({
    LAUNDRY_ACCESS_TOKEN_SECRET: SecretSchema,
    LAUNDRY_CSRF_PROOF_SECRET: SecretSchema,
  })
  .superRefine((value, context) => {
    if (value.LAUNDRY_ACCESS_TOKEN_SECRET === value.LAUNDRY_CSRF_PROOF_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["LAUNDRY_CSRF_PROOF_SECRET"],
        message: "access and CSRF secrets must be independent",
      });
    }
  });

export type LocalHostConfig = Readonly<{
  listenHost: "127.0.0.1" | "0.0.0.0";
  port: typeof LOCAL_PORT;
  browserOrigin: string;
  browserFetchSite: "same-site" | "same-origin";
  cookieSecure: boolean;
  hostAuthorities: readonly ["127.0.0.1:8787"];
  trustedProxyClientIpRequired: boolean;
}>;

export type LocalSigningSecrets = Readonly<{
  accessTokenSecret: string;
  csrfProofSecret: string;
}>;

export type LocalServerConfig = Readonly<LocalHostConfig & LocalSigningSecrets>;
export type NotificationProviderMode = "disabled" | "software_only";

function configError(error: z.ZodError): Error {
  const details = error.issues
    .map((issue) => {
      const field = issue.path[0];
      return `${typeof field === "string" ? field : "environment"}: ${issue.message}`;
    })
    .join("; ");
  return new Error(`Invalid local server configuration: ${details}`);
}

export function parseLocalHostConfig(env: NodeJS.ProcessEnv): LocalHostConfig {
  const result = LocalHostEnvironmentSchema.safeParse(env);
  if (!result.success) {
    throw configError(result.error);
  }

  // Exactly one of the two may be set (enforced above). Either one makes the
  // browser reach this server through TLS on its own origin, so both imply
  // same-origin fetch metadata and Secure cookies.
  const remoteOrigin = result.data.LAUNDRY_LAN_ORIGIN ?? result.data.LAUNDRY_PUBLIC_ORIGIN;
  return Object.freeze({
    listenHost: result.data.LAUNDRY_CONTAINER_RUNTIME === "1" ? "0.0.0.0" : "127.0.0.1",
    port: LOCAL_PORT,
    browserOrigin: remoteOrigin ?? LOCAL_BROWSER_ORIGIN,
    browserFetchSite: remoteOrigin === undefined ? "same-site" : "same-origin",
    cookieSecure: remoteOrigin !== undefined,
    hostAuthorities: LOCAL_HOST_AUTHORITIES,
    trustedProxyClientIpRequired: result.data.LAUNDRY_PUBLIC_ORIGIN !== undefined,
  });
}

export function parseLocalSigningSecrets(env: NodeJS.ProcessEnv): LocalSigningSecrets {
  const result = LocalSigningEnvironmentSchema.safeParse({
    ...env,
    LAUNDRY_ACCESS_TOKEN_SECRET: readSecretValue(env, "LAUNDRY_ACCESS_TOKEN_SECRET"),
    LAUNDRY_CSRF_PROOF_SECRET: readSecretValue(env, "LAUNDRY_CSRF_PROOF_SECRET"),
  });
  if (!result.success) {
    throw configError(result.error);
  }

  return Object.freeze({
    accessTokenSecret: result.data.LAUNDRY_ACCESS_TOKEN_SECRET,
    csrfProofSecret: result.data.LAUNDRY_CSRF_PROOF_SECRET,
  });
}

export function parseLocalServerConfig(env: NodeJS.ProcessEnv): LocalServerConfig {
  return Object.freeze({
    ...parseLocalHostConfig(env),
    ...parseLocalSigningSecrets(env),
  });
}

export function parseNotificationProviderMode(env: NodeJS.ProcessEnv): NotificationProviderMode {
  const raw = env.LAUNDRY_NOTIFICATION_PROVIDER_MODE;
  if (raw === undefined || raw === "" || raw === "disabled") return "disabled";
  if (raw === "software_only") return "software_only";
  throw new Error(
    "Invalid local server configuration: LAUNDRY_NOTIFICATION_PROVIDER_MODE must be disabled or software_only",
  );
}

/**
 * Mock print spool root (product design §7: an explicitly configured directory).
 * Unset means no spool, and print.ticket.process keeps its ESC/POS behaviour.
 */
export function parseLocalPrintSpoolDir(env: NodeJS.ProcessEnv): string | null {
  const raw = env.LAUNDRY_PRINT_SPOOL_DIR?.trim();
  if (raw === undefined || raw.length === 0) return null;
  if (!raw.startsWith("/")) {
    throw new Error("Invalid local server configuration: LAUNDRY_PRINT_SPOOL_DIR must be absolute");
  }
  return raw;
}

/** Installed Windows defaults to its private photo root; other runtimes opt in. */
export function parseLocalPhotoStoreDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const raw = env.LAUNDRY_PHOTO_STORE_DIR?.trim();
  // Older installed login controllers do not emit PHOTO_STORE_DIR. Derive the
  // same private path in the new server so upgrading survives the next login.
  const installedWindows = platform === "win32" && env.LAUNDRY_RUNTIME_RELEASE !== undefined;
  if (raw === "" || (raw === undefined && !installedWindows)) return null;
  const local = env.LOCALAPPDATA;
  const windowsRoot =
    platform === "win32" &&
    local !== undefined &&
    /^[a-z]:\\/iu.test(local) &&
    !/[\x00-\x1f<>:"|?*]/u.test(local.slice(2)) &&
    !local.split("\\").some((part) => part === "." || part === ".." || /[. ]$/u.test(part))
      ? win32.join(local, "laundry-desk-v2", "runtime-companion", "photos")
      : null;
  if (
    platform === "win32"
      ? windowsRoot === null ||
        (raw !== undefined && raw.toLowerCase() !== windowsRoot.toLowerCase())
      : raw !== "/var/lib/laundry/photos"
  ) {
    throw new Error(
      "Invalid local server configuration: LAUNDRY_PHOTO_STORE_DIR must be the managed photo directory",
    );
  }
  return raw ?? windowsRoot;
}
