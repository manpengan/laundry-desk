export type PrintContinuity = Readonly<{
  capture: () => number;
  isCurrent: (token: number) => boolean;
  invalidate: () => void;
}>;

/** A suspend/resume boundary invalidates only claims already in flight. */
export function createPrintContinuity(): PrintContinuity {
  let generation = 0;
  return Object.freeze({
    capture: () => generation,
    isCurrent: (token: number) => Number.isSafeInteger(token) && token === generation,
    invalidate: () => {
      generation = generation === Number.MAX_SAFE_INTEGER ? 0 : generation + 1;
    },
  });
}
