import { useEffect, useMemo } from "react";

/** Every request owns a generation; replacing its owner or unmounting invalidates it. */
export function useRequestLifetime(owner: unknown) {
  const lifetime = useMemo(() => {
    let generation = 0;
    let active = true;
    return Object.freeze({
      begin: () => (active ? ++generation : null),
      isCurrent: (token: number) => active && token === generation,
      invalidate: () => {
        generation += 1;
      },
      activate: () => {
        active = true;
      },
      dispose: () => {
        active = false;
        generation += 1;
      },
    });
  }, [owner]);
  useEffect(() => {
    lifetime.activate();
    return () => lifetime.dispose();
  }, [lifetime]);
  return lifetime;
}
