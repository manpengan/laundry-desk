const browserSessionSources = new WeakSet<object>();
const edgeReplaySources = new WeakSet<object>();

export const registerBrowserSessionSource = <T extends object>(source: T): T => {
  browserSessionSources.add(source);
  return source;
};

export const registerEdgeReplaySource = <T extends object>(source: T): T => {
  edgeReplaySources.add(source);
  return source;
};

export const hasBrowserSessionSourceProvenance = (value: unknown): boolean =>
  typeof value === "object" && value !== null && browserSessionSources.has(value);

export const hasEdgeReplaySourceProvenance = (value: unknown): boolean =>
  typeof value === "object" && value !== null && edgeReplaySources.has(value);
