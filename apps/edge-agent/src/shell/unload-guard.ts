/** The operator's answer that lets the page go despite unsaved counter work. */
export const LEAVE_ANYWAY = 1;

/**
 * Decides whether the main window leaves a page that asked to stay because of unsaved
 * counter work. While Windows signs out or shuts down, a modal only blocks that, and what
 * the recovery journal saved comes back at the next start, so it leaves without asking.
 */
export function leavesDespiteUnsavedWork(sessionEnding: boolean, askOperator: () => number) {
  return sessionEnding || askOperator() === LEAVE_ANYWAY;
}
