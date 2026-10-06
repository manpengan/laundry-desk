import { useState } from "react";
import { Button, useToast } from "@laundry/ui";
import type { ReceivePageProps } from "./ReceivePage.js";
import type { ReceiveWorkspace } from "./receive-workspace.js";
import { confirmReceivePayment } from "./receive-payment.js";
import { ReceiveTicketResult } from "./ReceiveTicketResult.js";
import { OrderDetailDrawer } from "./OrderDetailDrawer.js";
import { useReceivedOrderBalance } from "./use-received-order-balance.js";

type Props = Pick<
  ReceivePageProps,
  | "commandClient"
  | "queryClient"
  | "photoPort"
  | "paymentChannelPort"
  | "onTicketReady"
  | "queuePrintEnabled"
> &
  Readonly<{ store: ReceiveWorkspace; busy: boolean }>;

/** All post-receive actions refer to persisted garment/order identities. */
export function ReceiveCompletedWorkspace({
  store,
  busy,
  queryClient,
  photoPort,
  ...props
}: Props) {
  const { result, lines, ticketPreview, confirmedPaymentIntentIds } = store.getSnapshot();
  const toast = useToast();
  const [photoOrder, setPhotoOrder] = useState<string | null>(null);
  const balance = useReceivedOrderBalance(store, queryClient);
  if (result === null) return null;
  return (
    <>
      {balance.checking ? (
        <p role={balance.message ? "alert" : "status"}>
          {balance.message || "正在核对最新订单金额…"}
          {balance.message ? (
            <Button variant="secondary" onClick={() => void balance.refresh()}>
              重新核对
            </Button>
          ) : null}
        </p>
      ) : null}
      <ReceiveTicketResult
        {...props}
        queuePrintEnabled={props.queuePrintEnabled ?? false}
        result={result}
        lines={lines}
        preview={ticketPreview}
        busy={busy || balance.checking}
        notify={toast.push}
        onPaymentConfirmed={(intent) => {
          if (queryClient) void balance.refresh();
          else confirmReceivePayment(store, intent);
        }}
        hasChannelPayment={
          confirmedPaymentIntentIds.length > 0 ||
          result.paid_cents > Number(store.getSnapshot().paymentCents)
        }
        paymentReady={!balance.checking}
      />
      {queryClient && photoPort ? (
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => setPhotoOrder(result.order_id)}
          >
            衣物照片与订单详情
          </Button>
          <OrderDetailDrawer
            open={photoOrder === result.order_id}
            orderId={result.order_id}
            queryClient={queryClient}
            commandClient={props.commandClient}
            photoPort={photoPort}
            onClose={() => {
              setPhotoOrder(null);
              void balance.refresh();
            }}
          />
        </>
      ) : null}
    </>
  );
}
