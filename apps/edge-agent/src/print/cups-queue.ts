/** CUPS destination names accepted by every Edge print entry point. */
export const CUPS_QUEUE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

/** Stable CUPS job references are `<queue>-<positive queue number>`. */
export const CUPS_JOB_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}-[1-9][0-9]{0,9}$/u;

export function isCupsQueueName(value: string): boolean {
  return CUPS_QUEUE_NAME_PATTERN.test(value);
}

export function isCupsJobId(value: string): boolean {
  return CUPS_JOB_ID_PATTERN.test(value);
}

export function isCupsJobIdForQueue(queue: string, value: string): boolean {
  if (!isCupsQueueName(queue) || !isCupsJobId(value)) return false;
  const prefix = `${queue}-`;
  return value.startsWith(prefix) && /^[1-9][0-9]{0,9}$/u.test(value.slice(prefix.length));
}
