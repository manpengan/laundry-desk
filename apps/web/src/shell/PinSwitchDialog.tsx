import { Button, Dialog, Input, useToast } from "@laundry/ui";
import { useCallback, useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { AccessSession, SwitchableStaff } from "../auth/types.js";
import { validatePin } from "../auth/validate-pin.js";

export type PinSwitchDialogProps = {
  open: boolean;
  onClose: () => void;
  authClient: AuthClient;
  currentStaffId: string;
  onSwitched: (session: AccessSession) => void;
};

export function PinSwitchDialog({
  open,
  onClose,
  authClient,
  currentStaffId,
  onSwitched,
}: PinSwitchDialogProps) {
  const toast = useToast();
  const staff = authClient.listSwitchableStaff().filter((s) => s.staff_id !== currentStaffId);
  const [targetId, setTargetId] = useState<string>(staff[0]?.staff_id ?? "");
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
    if (!targetId) {
      setFormError("请选择目标员工");
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
        purpose: "quick_switch",
        target_staff_id: targetId,
      });
      if (!challenge.ok) {
        setFormError(challenge.error.message);
        toast.push(challenge.error.message, "error");
        return;
      }
      const verified = await authClient.verifyPin({
        challenge_id: challenge.data.challenge_id,
        pin,
      });
      // Clear PIN from local state ASAP; never log it.
      setPin("");
      if (!verified.ok) {
        setFormError(verified.error.message);
        toast.push(verified.error.message, "error");
        return;
      }
      onSwitched(verified.data);
      toast.push("已切换员工", "success");
      resetLocal();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }, [authClient, onClose, onSwitched, pin, resetLocal, targetId, toast]);

  return (
    <Dialog
      open={open}
      title="切换员工"
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
            disabled={submitting}
          >
            {submitting ? "验证中…" : "确认切换"}
          </Button>
        </>
      }
    >
      <div className="ld-pin-switch">
        <p className="ld-pin-switch__hint">选择目标员工并输入其 PIN（4–8 位数字）</p>
        <label className="ld-pin-switch__staff">
          <span className="ld-pin-switch__label">目标员工</span>
          <select
            className="ld-input"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={submitting}
            aria-label="目标员工"
          >
            {staff.length === 0 ? <option value="">无其他员工</option> : null}
            {staff.map((s: SwitchableStaff) => (
              <option key={s.staff_id} value={s.staff_id}>
                {s.display_name}
              </option>
            ))}
          </select>
        </label>
        <Input
          name="pin"
          label="PIN"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/gu, "").slice(0, 8))}
          {...(pinError ? { error: pinError } : {})}
          disabled={submitting}
        />
        {formError ? (
          <div className="ld-pin-switch__error" role="alert">
            {formError}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
