import { randomUUID } from "node:crypto";

import {
  EdgeReplayResponseSchema,
  classifyQueueEnvelopeCompatibility,
  createCommandError,
  type EdgeReplayRequest,
  type EdgeReplayResponse,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { executeCommand } from "../bus/executor.js";
import { createRuntimeBus, permissionsForAuthority } from "../bus/runtime.js";
import type { ActorContext, CommandResult } from "../bus/types.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import type { TenantContext } from "../db/types.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import { createPgReplayGuard } from "./pg-replay-guard.js";
import { preparePgReplay, type PreparedPgReplay } from "./pg-replay.js";
import { SERVER_EDGE_REPLAY_COMPATIBILITY_POLICY } from "./replay-compatibility.js";

type ReplayServiceDependencies = Readonly<{
  prepare: (
    pool: NonNullable<LocalRuntime["pool"]>,
    session: AuthorizedSession,
    request: EdgeReplayRequest,
  ) => Promise<PreparedPgReplay | null>;
}>;

const DEFAULT_DEPENDENCIES = Object.freeze({ prepare: preparePgReplay });

function fail(code: "RESOURCE_UNAVAILABLE" | "REPLAY_ARBITRATION_REQUIRED"): EdgeReplayResponse {
  return EdgeReplayResponseSchema.parse({
    ok: false,
    error: createCommandError(code),
  });
}

function replayFailure(result: CommandResult): EdgeReplayResponse | null {
  if (result.ok || result.error.code !== "REPLAY_ARBITRATION_REQUIRED") return null;
  return EdgeReplayResponseSchema.parse({ ok: false, error: result.error });
}

export async function executeEdgeReplay(
  runtime: LocalRuntime,
  session: AuthorizedSession,
  request: EdgeReplayRequest,
  newId: () => string = randomUUID,
  dependencies: ReplayServiceDependencies = DEFAULT_DEPENDENCIES,
): Promise<EdgeReplayResponse> {
  const compatibility = classifyQueueEnvelopeCompatibility(
    request.payload.envelope,
    SERVER_EDGE_REPLAY_COMPATIBILITY_POLICY,
  );
  if (compatibility.mode !== "replay") return fail("REPLAY_ARBITRATION_REQUIRED");
  if (runtime.mode !== "pg" || runtime.pool === null) {
    return fail("RESOURCE_UNAVAILABLE");
  }
  const prepared = await dependencies.prepare(runtime.pool, session, request);
  if (prepared === null) return fail("REPLAY_ARBITRATION_REQUIRED");
  const envelope = prepared.request.payload.envelope;
  if (envelope.payload.mode !== "direct") return fail("RESOURCE_UNAVAILABLE");
  const commandArgs = envelope.payload.args;

  const actor: ActorContext = Object.freeze({
    staffId: prepared.originalStaffId,
    deviceId: prepared.deviceId,
    via: "edge_replay" as const,
    permissions: permissionsForAuthority({
      role: prepared.role,
      is_privacy_admin: prepared.isPrivacyAdmin,
    }),
  });
  const tenant: TenantContext = Object.freeze({
    orgId: prepared.orgId,
    storeId: prepared.storeId,
    staffId: prepared.originalStaffId,
  });
  const { registry, chainHooks } = createRuntimeBus(runtime);
  const guarded = createPgReplayGuard(prepared, newId);
  const result = await withPoolClient(runtime.pool, (sql) =>
    executeCommand(sql, tenant, envelope.payload.command, commandArgs, {
      registry,
      actor,
      chainHooks,
      pendingStore: runtime.pendingStore,
      stepUpProofStore: runtime.stepUpProofStore,
      stepUpApproverAuthority: runtime.stepUpApproverAuthority,
      idempotencyStore: runtime.idempotencyStore,
      version: envelope.payload.version,
      dryRun: envelope.payload.dry_run,
      idempotencyKey: envelope.payload.idempotency_key,
      transactionGuard: guarded.guard,
      newId,
    }),
  );
  const arbitration = replayFailure(result);
  if (arbitration !== null) return arbitration;
  return EdgeReplayResponseSchema.parse({
    ok: true,
    data: {
      disposition: guarded.disposition(),
      command: result,
    },
  });
}
