/**
 * 58mm-style monospaced ticket text preview + browser print affordance.
 */

import { Button } from "@laundry/ui";
import type { TicketPreview } from "@laundry/domain";
import { useMemo, useState } from "react";
import { triggerBrowserPrint } from "./ticket-preview.js";

export type TicketPreviewPanelProps = Readonly<{
  preview: TicketPreview;
  /** Optional Browser-only preview hook when no local queue is available. */
  onTicketReady?: ((preview: TicketPreview) => void) | undefined;
  /** Optional async enqueue (e.g. print.ticket.enqueue) instead of browser print. */
  onEnqueuePrint?: (() => boolean | Promise<boolean>) | undefined;
  disabled?: boolean | undefined;
}>;

type TicketPrintActionOptions = Readonly<{
  preview: TicketPreview;
  onTicketReady?: ((preview: TicketPreview) => void) | undefined;
  onEnqueuePrint?: (() => boolean | Promise<boolean>) | undefined;
  browserPrint: () => void;
  onError: (error: unknown) => void;
}>;

export type TicketPrintAction = Readonly<{
  run: (
    options: TicketPrintActionOptions,
  ) => Promise<"completed" | "failed" | "busy" | "already-enqueued">;
}>;

/** One exclusive print action; an enqueue handler and browser print are mutually exclusive. */
export function createTicketPrintAction(
  onBusyChange: (busy: boolean) => void,
  onEnqueuedChange: (enqueued: boolean) => void = () => undefined,
): TicketPrintAction {
  let busy = false;
  let enqueued = false;
  return Object.freeze({
    async run(options): Promise<"completed" | "failed" | "busy" | "already-enqueued"> {
      if (busy) return "busy";
      if (enqueued && options.onEnqueuePrint !== undefined) return "already-enqueued";
      busy = true;
      onBusyChange(true);
      try {
        if (options.onEnqueuePrint !== undefined) {
          if (!(await options.onEnqueuePrint())) return "failed";
          enqueued = true;
          onEnqueuedChange(true);
          return "completed";
        }
        options.onTicketReady?.(options.preview);
        options.browserPrint();
        return "completed";
      } catch (error) {
        options.onError(error);
        return "failed";
      } finally {
        busy = false;
        onBusyChange(false);
      }
    },
  });
}

export function TicketPreviewPanel({
  preview,
  onTicketReady,
  onEnqueuePrint,
  disabled = false,
}: TicketPreviewPanelProps) {
  const [printing, setPrinting] = useState(false);
  const [enqueued, setEnqueued] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const printAction = useMemo(() => createTicketPrintAction(setPrinting, setEnqueued), []);
  const onPrint = () => {
    setPrintError(null);
    void printAction.run({
      preview,
      onTicketReady,
      onEnqueuePrint,
      browserPrint: triggerBrowserPrint,
      onError: () => setPrintError("打印任务提交失败，请稍后重试"),
    });
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
          disabled={disabled || printing || enqueued}
          data-testid="ticket-print-button"
        >
          {enqueued ? "已排队" : printing ? "提交中…" : "打印小票"}
        </Button>
      </div>
      {printError === null ? null : (
        <p className="ld-ticket-preview__error ld-no-print" role="alert">
          {printError}
        </p>
      )}
      <pre className="ld-ticket-preview__body" data-testid="ticket-preview-body">
        {preview.lines.join("\n")}
      </pre>
    </section>
  );
}
