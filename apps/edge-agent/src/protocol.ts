import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isNormalizedSpaPath,
  sha256Hex,
  verifySpaIntegrity,
  type SpaManifest,
  type SpaManifestEntry,
} from "./lib/integrity.js";

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'none'";

type VerifiedAsset = Readonly<{
  body: ArrayBuffer;
  entry: SpaManifestEntry;
}>;

/** Create a session-agnostic app:// handler backed only by verified manifest assets. */
export function createAppProtocolHandler(
  spaRoot: string,
  manifest: SpaManifest,
): (request: Request) => Response {
  const verified = verifySpaIntegrity(spaRoot, manifest);
  const assets = loadVerifiedAssets(spaRoot, verified);

  return (request: Request): Response => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return response("method not allowed", 405);
    }

    const key = manifestKeyFromRequest(request);
    if (key === null) {
      return response("bad request", 400);
    }

    const asset = assets.get(key);
    if (!asset) {
      return response("not found", 404);
    }

    return new Response(request.method === "HEAD" ? null : asset.body, {
      status: 200,
      headers: {
        "content-security-policy": CONTENT_SECURITY_POLICY,
        "content-type": asset.entry.mime,
        "x-content-type-options": "nosniff",
      },
    });
  };
}

function loadVerifiedAssets(
  spaRoot: string,
  manifest: SpaManifest,
): ReadonlyMap<string, VerifiedAsset> {
  const assets = new Map<string, VerifiedAsset>();
  for (const [path, entry] of Object.entries(manifest.entries)) {
    const body = readFileSync(join(spaRoot, ...path.split("/")));
    if (body.byteLength !== entry.bytes || sha256Hex(body) !== entry.sha256) {
      throw new Error(`SPA integrity changed while loading: ${path}`);
    }
    assets.set(path, Object.freeze({ body: Uint8Array.from(body).buffer, entry }));
  }
  return assets;
}

function manifestKeyFromRequest(request: Request): string | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }

  if (
    url.protocol !== "app:" ||
    url.hostname !== "local" ||
    url.host !== "local" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (decodedPath === "/") return "index.html";
  if (!decodedPath.startsWith("/")) return null;

  const key = decodedPath.slice(1);
  if (key === "manifest.json") return key;
  return isNormalizedSpaPath(key) ? key : null;
}

function response(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-security-policy": CONTENT_SECURITY_POLICY,
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
