import { Button, Dialog } from "@laundry/ui";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createReceiveWorkspace,
  hasReceiveWork,
  type ReceiveWorkspace,
} from "./receive-workspace.js";
import type { ReceiveRecoveryPort } from "../host/receive-recovery-port.js";
import type { QueryPort } from "../commands/types.js";
import type { SessionView } from "../auth/types.js";
import { connectReceiveRecovery } from "./receive-recovery.js";

type WorkspaceContext = Readonly<{
  store: ReceiveWorkspace;
  confirmDiscard: (message: string) => Promise<boolean>;
}>;
const Context = createContext<WorkspaceContext | null>(null);

export function ReceiveWorkspaceProvider({
  children,
  scope,
  recovery,
  session,
  query,
}: Readonly<{
  children: ReactNode;
  scope: string;
  recovery?: ReceiveRecoveryPort;
  session?: SessionView;
  query?: QueryPort;
}>) {
  const workspace = useMemo(() => {
    const store = createReceiveWorkspace();
    if (recovery !== undefined)
      store.patch({ recoveryStatus: "loading", recoveryMessage: "正在读取本机开单恢复记录…" });
    return { scope, store };
  }, [scope, recovery]);
  const { store } = workspace;
  useEffect(() => {
    if (recovery === undefined || session === undefined || query === undefined) return;
    return connectReceiveRecovery(
      store,
      recovery,
      {
        session_id: session.session.session_id,
        session_version: session.session.session_version,
      },
      query,
    );
  }, [store, recovery, session, query]);
  const [question, setQuestion] = useState<Readonly<{ scope: string; message: string }> | null>(
    null,
  );
  const answerRef = useRef<((value: boolean) => void) | null>(null);
  const value = useMemo(
    () =>
      Object.freeze({
        store,
        confirmDiscard: (message: string) =>
          new Promise<boolean>((resolve) => {
            answerRef.current?.(false);
            answerRef.current = resolve;
            setQuestion({ scope, message });
          }),
      }),
    [scope, store],
  );
  const finish = (answer: boolean): void => {
    answerRef.current?.(answer);
    answerRef.current = null;
    setQuestion(null);
  };
  useEffect(() => {
    if (typeof window === "undefined") return;
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!hasReceiveWork(store.getSnapshot())) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      answerRef.current?.(false);
      answerRef.current = null;
    };
  }, [store]);
  return (
    <Context.Provider value={value}>
      {children}
      <Dialog
        open={question?.scope === scope}
        title="保护当前开单内容"
        onClose={() => finish(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => finish(false)}>
              保留，返回操作
            </Button>
            <Button type="button" onClick={() => finish(true)}>
              确认后继续
            </Button>
          </>
        }
      >
        <p>{question?.scope === scope ? question.message : ""}</p>
      </Dialog>
    </Context.Provider>
  );
}

export function useReceiveWorkspaceAccess() {
  const provided = useContext(Context);
  const [fallback] = useState(createReceiveWorkspace);
  const store = provided?.store ?? fallback;
  const confirmDiscard = provided?.confirmDiscard ?? (async () => false);
  return { store, confirmDiscard };
}

export function useReceiveWorkspace() {
  const access = useReceiveWorkspaceAccess();
  const { store } = access;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...access, state };
}
