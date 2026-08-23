import { Button } from "@laundry/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { AiStreamEvent } from "@laundry/contracts";

import type { AiPanelPort } from "../host/ai-port.js";

type PanelMessage = Readonly<{
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}>;

const SUGGESTIONS = Object.freeze([
  "查询今天的经营汇总，并列出来源和筛选条件",
  "按票号或顾客线索检索订单/顾客，隐去个人信息",
  "帮我按内置规程排查打印问题",
]);

export type AiPanelProps = Readonly<{
  open: boolean;
  onClose: () => void;
  authSessionId: string;
  aiPort: AiPanelPort;
}>;

export async function drainStaleAiTurn(
  aiPort: AiPanelPort,
  sessionId: string,
  after: number,
): Promise<boolean> {
  try {
    const result = await aiPort.stream(
      sessionId,
      after,
      new AbortController().signal,
      () => undefined,
    );
    return result.ok;
  } catch {
    return false;
  }
}

function nextId(): string {
  return globalThis.crypto.randomUUID();
}

function systemText(event: AiStreamEvent): string | null {
  if (event.type === "tool_call") return `正在执行有界只读工具：${event.tool}`;
  if (event.type === "tool_result")
    return `只读工具 ${event.tool}：${event.outcome}（回答须附来源与筛选条件）`;
  if (event.type === "error") return `AI 已停止（${event.code}）`;
  return null;
}

function applyEvent(
  messages: readonly PanelMessage[],
  assistantId: string,
  event: AiStreamEvent,
): readonly PanelMessage[] {
  if (event.type === "content_delta") {
    return Object.freeze(
      messages.map((message) =>
        message.id === assistantId
          ? Object.freeze({ ...message, text: `${message.text}${event.text}` })
          : message,
      ),
    );
  }
  const text = systemText(event);
  return text === null
    ? messages
    : Object.freeze([
        ...messages,
        Object.freeze({ id: `${assistantId}:${event.cursor}`, role: "system" as const, text }),
      ]);
}

export function AiPanel({ open, onClose, authSessionId, aiPort }: AiPanelProps) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly PanelMessage[]>(Object.freeze([]));
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [canStop, setCanStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const operationGenerationRef = useRef(0);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    operationGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setConversationId(null);
    setMessages(Object.freeze([]));
    setPrompt("");
    setBusy(false);
    setCanStop(false);
    setError(null);
    setCursor(0);
  }, [authSessionId]);

  useEffect(
    () => () => {
      operationGenerationRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (returnFocus?.isConnected === true) returnFocus.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  const stop = () => {
    if (abortRef.current === null) return;
    operationGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setCanStop(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (text.length === 0 || busy) return;
    setError(null);
    setBusy(true);
    setPrompt("");
    const operationGeneration = operationGenerationRef.current + 1;
    operationGenerationRef.current = operationGeneration;
    const isCurrentOperation = (): boolean =>
      operationGenerationRef.current === operationGeneration;
    let activeConversationId = conversationId;
    if (activeConversationId === null) {
      const created = await aiPort.createSession();
      if (!isCurrentOperation()) return;
      if (!created.ok) {
        setError(created.error.message);
        setBusy(false);
        return;
      }
      activeConversationId = created.data.sessionId;
      setConversationId(activeConversationId);
    }
    const userId = nextId();
    const assistantId = nextId();
    setMessages((current) =>
      Object.freeze([
        ...current,
        Object.freeze({ id: userId, role: "user" as const, text }),
        Object.freeze({ id: assistantId, role: "assistant" as const, text: "" }),
      ]),
    );
    const turn = await aiPort.createTurn(activeConversationId, {
      prompt: text,
      idempotencyKey: nextId(),
    });
    if (!isCurrentOperation()) {
      if (turn.ok && !(await drainStaleAiTurn(aiPort, activeConversationId, cursor))) {
        console.warn("AI stale turn drain failed");
      }
      return;
    }
    if (!turn.ok) {
      setError(turn.error.message);
      setBusy(false);
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    setCanStop(true);
    const streamed = await aiPort.stream(activeConversationId, cursor, abort.signal, (item) => {
      if (!isCurrentOperation()) return;
      setCursor(item.cursor);
      if (item.turn_id !== turn.data.turnId) return;
      setMessages((current) => applyEvent(current, assistantId, item));
    });
    if (!isCurrentOperation()) return;
    abortRef.current = null;
    setCanStop(false);
    if (!streamed.ok) setError(streamed.error.message);
    setBusy(false);
  };

  if (!open) return null;
  return (
    <aside
      ref={panelRef}
      id="ld-ai-panel"
      className="ld-ai-panel"
      role="dialog"
      aria-label="AI 助手"
      data-testid="ai-panel"
    >
      <header className="ld-ai-panel__header">
        <div>
          <strong>AI 助手</strong>
          <small>经营 / 检索 / 规程 · 流式生成 · 仅限有界只读工具</small>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={onClose}>
          关闭
        </Button>
      </header>
      <div className="ld-ai-panel__messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="ld-ai-panel__empty">
            <p>回答会附只读来源与筛选条件，顾客资料默认脱敏。</p>
            <div className="ld-ai-panel__suggestions" aria-label="示例问题">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => setPrompt(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
            <p>未配置 AI 时会明确失败关闭。</p>
          </div>
        ) : (
          messages.map((message) => (
            <p
              key={message.id}
              className={`ld-ai-panel__message ld-ai-panel__message--${message.role}`}
            >
              <strong>
                {message.role === "user" ? "你" : message.role === "assistant" ? "AI" : "系统"}
              </strong>
              <span>{message.text || (busy && message.role === "assistant" ? "生成中…" : "")}</span>
            </p>
          ))
        )}
      </div>
      {error === null ? null : (
        <p className="ld-ai-panel__error" role="alert">
          {error}
        </p>
      )}
      <form className="ld-ai-panel__form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="ld-ai-prompt">问题</label>
        <textarea
          id="ld-ai-prompt"
          maxLength={8000}
          rows={3}
          value={prompt}
          disabled={busy}
          onChange={(event) => setPrompt(event.currentTarget.value)}
        />
        <div className="ld-ai-panel__actions">
          {busy && !canStop ? <span role="status">正在建立 AI 回合…</span> : null}
          {canStop ? (
            <Button type="button" variant="secondary" onClick={stop}>
              停止
            </Button>
          ) : null}
          <Button type="submit" disabled={busy || prompt.trim().length === 0}>
            发送
          </Button>
        </div>
      </form>
    </aside>
  );
}
