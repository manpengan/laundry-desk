import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { HealthPort } from "./types.js";

const DEFAULT_UNREACHABLE_MESSAGE = "无法连接本地服务，请确认服务已启动后重试";
const CHECKING_STATE: ServiceGateState = Object.freeze({ status: "checking" });

export type ServiceGateState =
  | Readonly<{ status: "checking" }>
  | Readonly<{ status: "unreachable"; message: string }>
  | Readonly<{ status: "ready" }>;

export type ServiceGateController = Readonly<{
  check: () => Promise<void>;
  dispose: () => void;
}>;

function unreachableMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_UNREACHABLE_MESSAGE;
}

export function createServiceGateController(
  health: HealthPort,
  onStateChange: (state: ServiceGateState) => void,
): ServiceGateController {
  let disposed = false;
  let requestSequence = 0;

  return {
    check: async () => {
      if (disposed) return;

      requestSequence += 1;
      const currentRequest = requestSequence;
      onStateChange({ status: "checking" });

      try {
        const result = await health.get();
        if (disposed || currentRequest !== requestSequence) return;

        onStateChange(
          result.ok
            ? { status: "ready" }
            : {
                status: "unreachable",
                message: unreachableMessage(result.error.message),
              },
        );
      } catch {
        if (disposed || currentRequest !== requestSequence) return;
        onStateChange({
          status: "unreachable",
          message: DEFAULT_UNREACHABLE_MESSAGE,
        });
      }
    },
    dispose: () => {
      disposed = true;
      requestSequence += 1;
    },
  };
}

export type ServiceGateViewProps = Readonly<{
  state: ServiceGateState;
  onRetry: () => void;
  children: ReactNode;
}>;

export function ServiceGateView({ state, onRetry, children }: ServiceGateViewProps) {
  if (state.status === "ready") return children;

  if (state.status === "checking") {
    return (
      <main aria-busy="true" aria-live="polite">
        <p>正在连接本地服务</p>
      </main>
    );
  }

  return (
    <main aria-live="polite">
      <h1>本地服务尚未就绪</h1>
      <p>{state.message}</p>
      <p>请确认本地 Web Server 已启动，然后重试。</p>
      <button type="button" onClick={onRetry}>
        重试
      </button>
    </main>
  );
}

export type ServiceGateProps = Readonly<{
  health: HealthPort;
  children: ReactNode;
}>;

export function ServiceGate({ health, children }: ServiceGateProps) {
  const [boundState, setBoundState] = useState<
    Readonly<{ health: HealthPort; state: ServiceGateState }>
  >(() => Object.freeze({ health, state: CHECKING_STATE }));
  const controllerRef = useRef<ServiceGateController | null>(null);
  const state = boundState.health === health ? boundState.state : CHECKING_STATE;

  useEffect(() => {
    const controller = createServiceGateController(health, (nextState) => {
      setBoundState(Object.freeze({ health, state: nextState }));
    });
    controllerRef.current = controller;
    void controller.check();

    return () => {
      controller.dispose();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [health]);

  const retry = useCallback(() => {
    void controllerRef.current?.check();
  }, []);

  return (
    <ServiceGateView state={state} onRetry={retry}>
      {children}
    </ServiceGateView>
  );
}
