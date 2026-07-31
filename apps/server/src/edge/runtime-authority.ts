import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { createEdgeAuthorityService, type EdgeAuthorityService } from "./authority-service.js";
import { deriveEdgeAuthorityKeyPair } from "./authority-key.js";
import { createMemoryAuthorityStore } from "./memory-authority-store.js";
import { createPgAuthorityStore } from "./pg-authority-store.js";

function createAuthority(
  store: ReturnType<typeof createMemoryAuthorityStore> | ReturnType<typeof createPgAuthorityStore>,
  secret: string,
): EdgeAuthorityService {
  return createEdgeAuthorityService({
    store,
    randomUUID,
    keyPair: deriveEdgeAuthorityKeyPair(secret),
  });
}

export const createMemoryRuntimeAuthority = (secret: string): EdgeAuthorityService =>
  createAuthority(createMemoryAuthorityStore(), secret);

export const createPgRuntimeAuthority = (pool: PgPool, secret: string): EdgeAuthorityService =>
  createAuthority(createPgAuthorityStore(pool), secret);
