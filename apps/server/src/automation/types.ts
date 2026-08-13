import type { AutomationPolicy, AutomationPolicyDraft, AutomationRun } from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import type { AutomationWorkerController } from "./worker-controller.js";

export type StoredAutomationPolicy = AutomationPolicy &
  Readonly<{
    org_id: string;
    created_by_staff_id: string;
    updated_by_staff_id: string;
  }>;

export type AutomationStoreContext = Readonly<{
  client: SqlClient;
  tenant: TenantContext;
}>;

export type AutomationTransition = "approve" | "pause" | "resume" | "archive";

export type AutomationAttempt = Readonly<{
  policyId: string;
  policyVersion: number;
  runId: string;
  leaseToken: string;
  argsSha256: string;
  objectCount: number;
  amountCents: number;
  startedAt: Date;
}>;

export type AutomationAttemptAuthorization = Readonly<{
  authorized: boolean;
  reason: "AUTHORIZED" | "POLICY_DENIED" | "OUTSIDE_WINDOW" | "QUOTA_EXCEEDED";
}>;

export type AutomationAttemptSettlement = AutomationAttempt &
  Readonly<{
    outcome: "executed" | "failed";
    errorCode: string | null;
    completedAt: Date;
  }>;

export type AutomationRecordOnlyAttempt = Readonly<{
  policyId: string;
  policyVersion: number;
  runId: string;
  outcome: "skipped" | "failed";
  argsSha256: string;
  errorCode: string;
  at: Date;
}>;

export type AutomationStore = Readonly<{
  create: (
    context: AutomationStoreContext,
    id: string,
    draft: AutomationPolicyDraft,
    now: Date,
  ) => Promise<boolean>;
  update: (
    context: AutomationStoreContext,
    id: string,
    expectedVersion: number,
    draft: AutomationPolicyDraft,
    now: Date,
  ) => Promise<boolean>;
  transition: (
    context: AutomationStoreContext,
    id: string,
    expectedVersion: number,
    operation: AutomationTransition,
    now: Date,
  ) => Promise<boolean>;
  get: (context: AutomationStoreContext, id: string) => Promise<StoredAutomationPolicy | null>;
  list: (
    context: AutomationStoreContext,
    status: AutomationPolicy["status"] | undefined,
    limit: number,
  ) => Promise<readonly StoredAutomationPolicy[]>;
  listRuns: (
    context: AutomationStoreContext,
    policyId: string,
    limit: number,
  ) => Promise<readonly AutomationRun[]>;
  listDue: (
    context: AutomationStoreContext,
    now: Date,
    limit: number,
  ) => Promise<readonly StoredAutomationPolicy[]>;
  beginAttempt: (
    context: AutomationStoreContext,
    attempt: AutomationAttempt,
  ) => Promise<AutomationAttemptAuthorization>;
  settleAttempt: (
    context: AutomationStoreContext,
    settlement: AutomationAttemptSettlement,
  ) => Promise<boolean>;
  recordAttempt: (
    context: AutomationStoreContext,
    attempt: AutomationRecordOnlyAttempt,
  ) => Promise<boolean>;
}>;

export type AutomationHandlerDeps = Readonly<{
  store: AutomationStore;
  now?: () => Date;
  worker?: AutomationWorkerController;
}>;
