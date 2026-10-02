/** Pure helpers for choosing a receipt printer among the OS print queues. */

const VIRTUAL_QUEUE =
  /(^fax$|传真|microsoft print to pdf|microsoft xps|xps document writer|onenote|^pdf\b|print to pdf|导出为 ?pdf)/iu;
const RECEIPT_HINT = /(xp-?\d{2}|pos|receipt|thermal|58 ?mm|80 ?mm|小票|热敏|票据)/iu;

/** Windows ships Fax / PDF / XPS / OneNote queues that can never print a ticket. */
export function isVirtualPrinterQueue(name: string): boolean {
  return VIRTUAL_QUEUE.test(name.trim());
}

/**
 * The queue to preselect: the configured one, else a likely receipt printer,
 * else nothing — never a virtual queue just because it is listed first.
 */
export function suggestReceiptQueue(configured: string | null, queues: readonly string[]): string {
  if (configured !== null && queues.includes(configured)) return configured;
  const physical = queues.filter((queue) => !isVirtualPrinterQueue(queue));
  return (
    physical.find((queue) => RECEIPT_HINT.test(queue)) ??
    (physical.length === 1 ? physical[0]! : "")
  );
}

export function printerQueueLabel(name: string): string {
  return isVirtualPrinterQueue(name) ? `${name}（非小票机）` : name;
}
