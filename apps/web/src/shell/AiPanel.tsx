import { Button } from "@laundry/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { AiStreamEvent } from "@laundry/contracts";

import type { AiPanelPort } from "../host/ai-port.js";

type PanelMessage = Readonly<{
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}>;

export type AiPanelProps = Readonly<{
  open: boolean;
  onClose: () => void;
  authSessionId: string;
  aiPort: AiPanelPort;
}>;

function nextId(): string {
  return globalThis.crypto.randomUUID();
}

function systemText(event: AiStreamEvent): string | null {
  if (event.type === "tool_call") return `正在执行只读工具：${event.tool}`;
  if (event.type === "tool_result") return `只读工具 ${event.tool}：${event.outcome}`;
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
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setConversationId(null);
    setMessages(Object.freeze([]));
    setPrompt("");
    setBusy(false);
    setError(null);
    setCursor(0);
  }, [authSessionId]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (text.length === 0 || busy) return;
    setError(null);
    setBusy(true);
    setPrompt("");
    let activeConversationId = conversationId;
    if (activeConversationId === null) {
      const created = await aiPort.createSession();
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
    if (!turn.ok) {
      setError(turn.error.message);
      setBusy(false);
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    const streamed = await aiPort.stream(activeConversationId, cursor, abort.signal, (item) => {
      setCursor(item.cursor);
      if (item.turn_id !== turn.data.turnId) return;
      setMessages((current) => applyEvent(current, assistantId, item));
    });
    abortRef.current = null;
    if (!streamed.ok) setError(streamed.error.message);
    setBusy(false);
  };

  if (!open) return null;
  return (
    <aside className="ld-ai-panel" aria-label="AI 助手" data-testid="ai-panel">
      <header className="ld-ai-panel__header">
        <div>
          <strong>AI 助手</strong>
          <small>流式生成 · 仅限有界只读工具</small>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </header>
      <div className="ld-ai-panel__messages" aria-live="polite">
        {messages.length === 0 ? (
          <p className="ld-ai-panel__empty">输入问题开始。未配置 AI 时会明确失败关闭。</p>
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
          {busy ? (
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
