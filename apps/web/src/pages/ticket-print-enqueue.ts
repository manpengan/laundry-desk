import type { TicketPreview } from "@laundry/domain";

import type { CommandPort } from "../commands/types.js";

export type PrintNotification = (message: string, kind: "success" | "error") => void;

/** Keep a post-commit host callback failure distinct from the successful receive. */
export function notifyReceiveSuccess(
  onTicketReady: ((preview: TicketPreview) => void) | undefined,
  preview: TicketPreview,
  ticketNo: string,
  notify: PrintNotification,
): void {
  try {
    onTicketReady?.(preview);
    notify(`开单成功 ${ticketNo}`, "success");
  } catch {
    notify(`开单成功 ${ticketNo}；小票联动失败，可从订单详情重试`, "error");
  }
}

/** Submit only the server-authoritative order identity to the local print queue. */
export async function enqueueTicketPrint(
  commandClient: CommandPort,
  orderId: string,
  ticketNo: string,
  notify: PrintNotification,
): Promise<boolean> {
  try {
    const response = await commandClient.execute<unknown>("print.ticket.enqueue", {
      order_id: orderId,
    });
    if (!response.ok) {
      notify(response.error.message ?? response.error.code, "error");
      return false;
    }
    notify(`已排队打印 ${ticketNo}`, "success");
    return true;
  } catch {
    notify("无法提交打印任务，请检查本地服务连接", "error");
    return false;
  }
}
