/**
 * 58mm-style monospaced ticket text preview + browser print affordance.
 */

import { Button } from "@laundry/ui";
import type { TicketPreview } from "@laundry/domain";
import { triggerBrowserPrint } from "./ticket-preview.js";

export type TicketPreviewPanelProps = Readonly<{
  preview: TicketPreview;
  /** Optional parent hook for later USB / queue print (Agent B). */
  onTicketReady?: ((preview: TicketPreview) => void) | undefined;
  /** Optional async enqueue (e.g. print.ticket.enqueue) before browser print. */
  onEnqueuePrint?: (() => void | Promise<void>) | undefined;
  disabled?: boolean | undefined;
}>;

export function TicketPreviewPanel({
  preview,
  onTicketReady,
  onEnqueuePrint,
  disabled = false,
}: TicketPreviewPanelProps) {
  const onPrint = () => {
    void (async () => {
      await onEnqueuePrint?.();
      onTicketReady?.(preview);
      triggerBrowserPrint();
    })();
  };

  return (
    <section className="ld-ticket-preview" data-testid="ticket-preview" aria-label="小票预览">
      <div className="ld-ticket-preview__header ld-no-print">
        <h2 className="ld-ticket-preview__title">小票预览</h2>
        <Button
          variant="secondary"
          type="button"
          size="sm"
          onClick={onPrint}
          disabled={disabled}
          data-testid="ticket-print-button"
        >
          打印小票
        </Button>
      </div>
      <pre className="ld-ticket-preview__body" data-testid="ticket-preview-body">
        {preview.lines.join("\n")}
      </pre>
    </section>
  );
}
