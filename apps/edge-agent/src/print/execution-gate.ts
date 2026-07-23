export type ExecutionGate = <T>(operation: () => Promise<T>) => Promise<T>;

export function createExecutionGate(): ExecutionGate {
  let tail = Promise.resolve();

  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
