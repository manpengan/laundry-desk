import type { ChannelIntent } from "@laundry/contracts";
import type { TicketPreview } from "@laundry/domain";

import type { CommandPort } from "../commands/types.js";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import { ChannelCollectCard } from "./ChannelCollectCard.js";
import { ReceiveResult } from "./ReceiveResult.js";
import { TicketPrintWaiverNotice } from "./TicketPrintWaiverNotice.js";
import { TicketPreviewPanel } from "./TicketPreviewPanel.js";
import type { ReceiveLineDraft, ReceiveOrderResult } from "./order-form.js";
import { enqueueTicketPrint, type PrintNotification } from "./ticket-print-enqueue.js";

type ReceiveTicketResultProps = Readonly<{
  busy: boolean;
  commandClient: CommandPort;
  notify: PrintNotification;
  onTicketReady?: (preview: TicketPreview) => void;
  preview: TicketPreview | null;
  queuePrintEnabled: boolean;
  result: ReceiveOrderResult | null;
  lines?: readonly ReceiveLineDraft[];
  paymentChannelPort?: PaymentChannelPort;
  onPaymentConfirmed: (intent: ChannelIntent) => void;
  hasChannelPayment?: boolean;
  paymentReady?: boolean;
}>;

export function ReceiveTicketResult({
  busy,
  commandClient,
  notify,
  onTicketReady,
  preview,
  queuePrintEnabled,
  result,
  lines,
  paymentChannelPort,
  onPaymentConfirmed,
  hasChannelPayment = false,
  paymentReady = true,
}: ReceiveTicketResultProps) {
  if (result === null) return null;
  const onEnqueuePrint = () =>
    enqueueTicketPrint(commandClient, result.order_id, result.ticket_no, notify);

  return (
    <>
      <ReceiveResult result={result} lines={lines} />
      {paymentChannelPort === undefined || !paymentReady ? null : (
        <ChannelCollectCard
          port={paymentChannelPort}
          order={{ order_id: result.order_id, status: "open", balance_cents: result.balance_cents }}
          refreshKey={0}
          disabled={busy}
          onPaid={onPaymentConfirmed}
        />
      )}
      {preview === null ? null : (
        <>
          {hasChannelPayment ? (
            <p role="note">以下为开单时的小票，不包含后续扫码付款；最新金额见上方开单结果。</p>
          ) : null}
          <TicketPreviewPanel
            key={result.order_id}
            preview={preview}
            {...(onTicketReady === undefined ? {} : { onTicketReady })}
            {...(queuePrintEnabled ? { onEnqueuePrint } : {})}
            disabled={busy || result.waivers.skip_ticket_print}
          />
          {result.waivers.skip_ticket_print ? <TicketPrintWaiverNotice /> : null}
        </>
      )}
    </>
  );
}
