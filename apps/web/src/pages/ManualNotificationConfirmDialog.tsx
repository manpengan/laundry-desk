import { Button, Dialog } from "@laundry/ui";

export type ManualNotificationConfirmation = Readonly<{
  orderCount: number;
  messages: readonly string[];
}>;

export function ManualNotificationConfirmDialog({
  confirmation,
  busy,
  onClose,
  onConfirm,
}: Readonly<{
  confirmation: ManualNotificationConfirmation | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}>) {
  return (
    <Dialog
      open={confirmation !== null}
      title="确认生成催取名单"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>
            确认生成名单
          </Button>
        </>
      }
    >
      {confirmation === null ? null : (
        <>
          <p>
            将为 {confirmation.orderCount} 个订单生成 {confirmation.messages.length}{" "}
            条人工联系记录。此操作不会发送短信或微信。
          </p>
          <ol>
            {confirmation.messages.map((message, index) => (
              <li key={`${index}-${message}`}>{message}</li>
            ))}
          </ol>
        </>
      )}
    </Dialog>
  );
}
