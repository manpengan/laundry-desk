import { PageHost } from "../pages/PageHost.js";
import { CounterShellCore, type CounterShellProps } from "./CounterShellCore.js";

export type { CounterShellProps } from "./CounterShellCore.js";

/** Synchronous shell retained for SSR tests and the public component API. */
export function CounterShell(props: CounterShellProps) {
  return <CounterShellCore {...props} PageHostComponent={PageHost} />;
}
