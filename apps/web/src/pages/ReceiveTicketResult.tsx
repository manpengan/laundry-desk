import { useState } from "react";
import type { TicketPreview } from "@laundry/domain";

import type { CommandPort } from "../commands/types.js";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import { ChannelCollectCard } from "./ChannelCollectCard.js";
import { ReceiveResult } from "./ReceiveResult.js";
import { TicketPrintWaiverNotice } from "./TicketPrintWaiverNotice.js";
import { TicketPreviewPanel } from "./TicketPreviewPanel.js";
import type { ReceiveOrderResult } from "./order-form.js";
import { enqueueTicketPrint, type PrintNotification } from "./ticket-print-enqueue.js";

type ReceiveTicketResultProps = Readonly<{
  busy: boolean;
  commandClient: CommandPort;
  notify: PrintNotification;
  onTicketReady?: (preview: TicketPreview) => void;
  preview: TicketPreview | null;
  queuePrintEnabled: boolean;
  result: ReceiveOrderResult | null;
  paymentChannelPort?: PaymentChannelPort;
}>;

type Collected = Readonly<{ order_id: string; amount_cents: number }>;

export function ReceiveTicketResult({
  busy,
  commandClient,
  notify,
  onTicketReady,
  preview,
  queuePrintEnabled,
  result,
  paymentChannelPort,
}: ReceiveTicketResultProps) {
  const [collected, setCollected] = useState<Collected | null>(null);
  if (result === null) return null;
  const onEnqueuePrint = () =>
    enqueueTicketPrint(commandClient, result.order_id, result.ticket_no, notify);
  // ADR-91 P1-1: a customer who prepays at drop-off scans right after the order opens;
  // the provider-confirmed amount is what the order now has paid.
  const paid = collected?.order_id === result.order_id ? collected.amount_cents : 0;
  const shown =
    paid === 0
      ? result
      : Object.freeze({
          ...result,
          paid_cents: result.paid_cents + paid,
          balance_cents: Math.max(0, result.balance_cents - paid),
        });

  return (
    <>
      <ReceiveResult result={shown} />
      {paymentChannelPort === undefined ? null : (
        <ChannelCollectCard
          port={paymentChannelPort}
          order={{ order_id: shown.order_id, status: "open", balance_cents: shown.balance_cents }}
          refreshKey={0}
          disabled={busy}
          onPaid={(intent) =>
            setCollected({ order_id: result.order_id, amount_cents: intent.amount_cents })
          }
        />
      )}
      {preview === null ? null : (
        <>
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
