import type { TicketPreview } from "@laundry/domain";

import type { CommandPort } from "../commands/types.js";
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
}>;

export function ReceiveTicketResult({
  busy,
  commandClient,
  notify,
  onTicketReady,
  preview,
  queuePrintEnabled,
  result,
}: ReceiveTicketResultProps) {
  if (result === null) return null;
  const onEnqueuePrint = () =>
    enqueueTicketPrint(commandClient, result.order_id, result.ticket_no, notify);

  return (
    <>
      <ReceiveResult result={result} />
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
