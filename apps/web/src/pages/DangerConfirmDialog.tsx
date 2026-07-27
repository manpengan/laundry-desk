/** Reusable confirmation gate for counter actions that cannot be undone. */

import { Button, Dialog, Input } from "@laundry/ui";
import { useEffect, useState } from "react";

export type DangerConfirmDialogProps = Readonly<{
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  /** The policy challenge is a second explicit confirmation, so the reason is retained. */
  serverConfirmation?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}>;

export function DangerConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  serverConfirmation = false,
  onClose,
  onConfirm,
}: DangerConfirmDialogProps) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  const canConfirm = serverConfirmation || reason.trim().length > 0;
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
            返回
          </Button>
          <Button
            variant="danger"
            type="button"
            onClick={() => onConfirm(reason.trim())}
            disabled={busy || !canConfirm}
          >
            {busy ? "处理中…" : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="ld-danger-confirm__description">{description}</p>
      {serverConfirmation ? (
        <p className="ld-danger-confirm__challenge" role="alert">
          服务端要求再次确认。继续后会立即执行，且不能撤回。
        </p>
      ) : (
        <Input
          name="danger-reason"
          label="操作原因"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={busy}
          hint="必填，原因将写入审计记录。"
          autoFocus
        />
      )}
    </Dialog>
  );
}
