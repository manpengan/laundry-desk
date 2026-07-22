/**
 * Process-local pending-action store for M1 local server.
 * Production will use Postgres CAS; this is intentional single-process scaffolding.
 */

import { MemoryPendingActionStore } from "./store.js";
import type { PendingActionStore } from "./types.js";

/** Shared in-process store used by default policy enforcement + executeCommand. */
export const processPendingActionStore: PendingActionStore = new MemoryPendingActionStore();
