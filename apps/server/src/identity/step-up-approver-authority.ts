import type { StepUpApproverAuthority } from "../bus/types.js";
import type { StaffAccessStore } from "../staff/access-store.js";
import {
  hasActiveAdmin,
  lockAuthorityRows,
  lockStaffCredentialLifecycle,
} from "../staff/sql-credential-support.js";

export function createMemoryStepUpApproverAuthority(
  store: StaffAccessStore,
): StepUpApproverAuthority {
  return async (_client, _tenant, approverStaffId) => {
    const approver = (await store.list()).find((row) => row.staff_id === approverStaffId);
    return approver?.is_active === true && approver.role === "admin";
  };
}

export const verifyPgStepUpApproverAuthority: StepUpApproverAuthority = async (
  client,
  tenant,
  approverStaffId,
) => {
  await lockStaffCredentialLifecycle(client, tenant);
  await lockAuthorityRows(client, tenant);
  return hasActiveAdmin(client, tenant, approverStaffId);
};
