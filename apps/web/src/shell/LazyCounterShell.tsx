import { LazyPageHost } from "../pages/LazyPageHost.js";
import { CounterShellCore, type CounterShellProps } from "./CounterShellCore.js";

/** Production shell whose active counter route is fetched on demand. */
export function LazyCounterShell(props: CounterShellProps) {
  return <CounterShellCore {...props} PageHostComponent={LazyPageHost} />;
}
