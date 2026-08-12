import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from "@laundry/contracts";

import type { CsrfProofSigner } from "../auth/csrf.js";
import type { createMemoryIdentityStore } from "../identity/memory-store.js";
import { createAccessTokenSigner } from "../identity/crypto-util.js";
import type { createPasswordPort } from "../identity/password.js";
import type { IdentityHandlerDeps } from "../handlers/identity-handlers.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import { processStepUpProofStore, type StepUpProofStore } from "../policy/step-up-proof-store.js";
import type { StaffRoleResolver } from "./staff-role-resolver.js";

type IdentityPorts = Readonly<{
  staff: ReturnType<typeof createMemoryIdentityStore>["staff"];
  orgStore: ReturnType<typeof createMemoryIdentityStore>["orgStore"];
  sessions: ReturnType<typeof createMemoryIdentityStore>["sessions"];
  refresh: ReturnType<typeof createMemoryIdentityStore>["refresh"];
  lifecycle: ReturnType<typeof createMemoryIdentityStore>["lifecycle"];
  pinChallenges: ReturnType<typeof createMemoryIdentityStore>["pinChallenges"];
  pinLockouts: ReturnType<typeof createMemoryIdentityStore>["pinLockouts"];
}>;

export function buildIdentityDeps(
  ports: IdentityPorts,
  passwordPort: ReturnType<typeof createPasswordPort>,
  accessTokenSecret: string,
  csrfProofSigner: CsrfProofSigner,
  pendingStore: PendingActionStore = processPendingActionStore,
  proofStore: StepUpProofStore = processStepUpProofStore,
  resolveStaffRole: StaffRoleResolver,
): IdentityHandlerDeps {
  const clock = {
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  };
  const sessionDeps = {
    sessions: ports.sessions,
    refresh: ports.refresh,
    lifecycle: ports.lifecycle,
    clock,
    accessTokenSigner: createAccessTokenSigner({
      secret: accessTokenSecret,
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    }),
    csrfProofMinter: csrfProofSigner,
  };
  const login = {
    staff: ports.staff,
    orgStore: ports.orgStore,
    passwordPort,
    sessions: sessionDeps,
  };
  const pin = {
    challenges: ports.pinChallenges,
    lockouts: ports.pinLockouts,
    staff: ports.staff,
    pinPort: passwordPort,
    clock,
    sessions: sessionDeps,
  };

  return Object.freeze({
    login,
    sessions: sessionDeps,
    pin,
    pinStepUp: Object.freeze({
      ...pin,
      pending: pendingStore,
      proofs: proofStore,
      resolveStaffRole,
    }),
    resolveBinding: () =>
      Object.freeze({
        session: null,
        refreshSecret: null,
      }),
  });
}
