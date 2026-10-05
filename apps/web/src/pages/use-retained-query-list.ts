import { useCallback, useState } from "react";
import type { QueryPort } from "../commands/types.js";
import { useRequestLifetime } from "./use-request-lifetime.js";

type Messages = Readonly<{ unavailable: string; invalid: string }>;

/** Failed refreshes retain the last successful rows and an error until a read succeeds. */
export function useRetainedQueryList<T>(
  queryClient: QueryPort,
  name: string,
  parse: (value: unknown) => readonly T[] | null,
  messages: Messages,
) {
  const requests = useRequestLifetime(queryClient);
  const [rows, setRows] = useState<readonly T[]>(Object.freeze([]));
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { unavailable, invalid } = messages;
  const load = useCallback(
    async (body: Readonly<Record<string, unknown>>): Promise<readonly T[] | null> => {
      const token = requests.begin();
      if (token === null) return null;
      setBusy(true);
      try {
        const response = await queryClient.execute<unknown>(name, body);
        if (!requests.isCurrent(token)) return null;
        if (!response.ok) {
          setError(unavailable);
          return null;
        }
        const parsed = parse(response.data);
        if (parsed === null) {
          setError(invalid);
          return null;
        }
        setRows(parsed);
        setLoaded(true);
        setError(null);
        return parsed;
      } catch {
        if (requests.isCurrent(token)) setError(unavailable);
        return null;
      } finally {
        if (requests.isCurrent(token)) setBusy(false);
      }
    },
    [invalid, name, parse, queryClient, requests, unavailable],
  );
  return { rows, busy, loaded, error, load };
}
