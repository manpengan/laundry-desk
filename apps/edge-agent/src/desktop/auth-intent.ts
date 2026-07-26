export type LoginIntentGate = Readonly<{
  beginLogin: () => number;
  registerValidLogin: (invocation: number) => boolean;
  cancelPendingLogins: () => void;
}>;

/** Orders valid login intents without letting malformed input mutate authentication state. */
export function createLoginIntentGate(): LoginIntentGate {
  let invocationSequence = 0;
  let latestValidInvocation = 0;
  let cancelledThroughInvocation = 0;

  return Object.freeze({
    beginLogin(): number {
      if (invocationSequence === Number.MAX_SAFE_INTEGER) {
        throw new Error("Login invocation sequence exhausted");
      }
      invocationSequence += 1;
      return invocationSequence;
    },
    registerValidLogin(invocation: number): boolean {
      if (
        !Number.isSafeInteger(invocation) ||
        invocation <= latestValidInvocation ||
        invocation > invocationSequence
      ) {
        return false;
      }
      latestValidInvocation = invocation;
      return invocation > cancelledThroughInvocation;
    },
    cancelPendingLogins(): void {
      cancelledThroughInvocation = invocationSequence;
    },
  });
}
