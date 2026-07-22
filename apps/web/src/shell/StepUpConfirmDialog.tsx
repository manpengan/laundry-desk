/**
 * R4/R5 step-up: other staff enters PIN on-site (session actor unchanged).
 */

import { Button, Dialog, Input, useToast } from "@laundry/ui";
import { useCallback, useMemo, useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SwitchableStaff } from "../auth/types.js";
import { validatePin } from "../auth/validate-pin.js";

export type StepUpConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  authClient: AuthClient;
  /** Pending card nonce from POLICY_*_REQUIRED. */
  confirmRef: string;
  /** Creator session staff — cannot self-approve. */
  currentStaffId: string;
  /** Optional command label for the dialog title area. */
  commandLabel?: string;
  /** Called after proof is issued (parent re-submits confirm_ref). */
  onApproved: (proof: Readonly<{ step_up_proof_id: string; expires_at: number }>) => void;
};

export function StepUpConfirmDialog({
  open,
  onClose,
  authClient,
  confirmRef,
  currentStaffId,
  commandLabel = "高风险操作",
  onApproved,
}: StepUpConfirmDialogProps) {
  const toast = useToast();
  const approvers = useMemo(
    () => authClient.listSwitchableStaff().filter((s) => s.staff_id !== currentStaffId),
    [authClient, currentStaffId],
  );
  const [approverId, setApproverId] = useState<string>(approvers[0]?.staff_id ?? "");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const resetLocal = useCallback(() => {
    setPin("");
    setPinError(undefined);
    setFormError(null);
    setSubmitting(false);
  }, []);

  const handleClose = useCallback(() => {
    resetLocal();
    onClose();
  }, [onClose, resetLocal]);

  const onSubmit = useCallback(async () => {
    setFormError(null);
    if (!approverId) {
      setFormError("请选择复核人");
      return;
    }
    const pinValidation = validatePin(pin);
    if (pinValidation) {
      setPinError(pinValidation);
      return;
    }
    setPinError(undefined);
    setSubmitting(true);
    try {
      const challenge = await authClient.createPinChallenge({
        purpose: "step_up",
        pending_action_ref: confirmRef,
        approver_staff_id: approverId,
      });
      if (!challenge.ok) {
        setFormError(challenge.error.message);
        toast.push(challenge.error.message, "error");
        return;
      }
      const verified = await authClient.verifyStepUpPin({
        challenge_id: challenge.data.challenge_id,
        pin,
      });
      setPin("");
      if (!verified.ok) {
        setFormError(verified.error.message);
        toast.push(verified.error.message, "error");
        return;
      }
      onApproved(verified.data);
      toast.push("复核通过，正在执行…", "success");
      resetLocal();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }, [approverId, authClient, confirmRef, onApproved, onClose, pin, resetLocal, toast]);

  const approverLabel = (staff: SwitchableStaff): string =>
    `${staff.display_name}${staff.role === "admin" ? "（店长）" : ""}`;

  return (
    <Dialog
      open={open}
      title="需要现场复核"
      onClose={handleClose}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={handleClose} disabled={submitting}>
            取消
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={() => void onSubmit()}
            disabled={submitting || approvers.length === 0}
          >
            {submitting ? "校验中…" : "确认 PIN"}
          </Button>
        </>
      }
    >
      <div className="ld-step-up">
        <p className="ld-step-up__hint">
          「{commandLabel}」需另一位员工输入 PIN 复核（不会切换当前登录人）。
        </p>
        <p className="ld-step-up__ref" title={confirmRef}>
          确认卡：{confirmRef.slice(0, 8)}…
        </p>
        {approvers.length === 0 ? (
          <div className="ld-step-up__error" role="alert">
            没有可复核的其他员工
          </div>
        ) : (
          <label className="ld-step-up__staff">
            <span className="ld-step-up__label">复核人</span>
            <select
              className="ld-step-up__select"
              value={approverId}
              onChange={(event) => setApproverId(event.target.value)}
              disabled={submitting}
            >
              {approvers.map((staff) => (
                <option key={staff.staff_id} value={staff.staff_id}>
                  {approverLabel(staff)}
                </option>
              ))}
            </select>
          </label>
        )}
        <Input
          name="step-up-pin"
          label="复核人 PIN"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          {...(pinError ? { error: pinError } : {})}
          disabled={submitting || approvers.length === 0}
        />
        {formError ? (
          <div className="ld-step-up__error" role="alert">
            {formError}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
