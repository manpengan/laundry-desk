import { Button } from "@laundry/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { AiOperationCard } from "../ai/AiOperationCard.js";
import { VisionPanel } from "../ai/VisionPanel.js";
import type { AiOperationPreview, AiStreamEvent } from "@laundry/contracts";

import type { AiPanelPort } from "../host/ai-port.js";

type PanelMessage = Readonly<{
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  preview?: AiOperationPreview;
}>;

const SUGGESTIONS = Object.freeze([
  "查询今天的经营汇总，并列出来源和筛选条件",
  "按票号或顾客线索检索订单/顾客，隐去个人信息",
  "分析最近 7 天经营收入与实际收入，并说明口径",
  "列出滞留 30 天的催取候选，只准备人工联系清单",
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
  if (event.type === "done" && event.finish_reason === "limit")
    return "回答已达到本次生成上限，内容可能不完整；未执行截断的操作请求。";
  if (event.type === "tool_call") return `正在执行有界工具：${event.tool}`;
  if (event.type === "tool_result")
    return `工具 ${event.tool}：${event.outcome}（回答须附来源与筛选条件）`;
  if (event.type === "error")
    return event.code === "AI_OUTPUT_LIMIT"
      ? "AI 已停止：供应商用量或输出超出本次限制。请检查 AI 配置和供应商账单；用量无法核实时，管理员须重新配置后才能继续。"
      : `AI 已停止（${event.code}）。如本次未收到用量报告，预留额度已保守结算；管理员核查供应商账单和 AI 配置后可恢复。`;
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
        Object.freeze({
          id: `${assistantId}:${event.cursor}`,
          role: "system" as const,
          text,
          ...(event.type === "tool_result" && event.preview !== undefined
            ? { preview: event.preview }
            : {}),
        }),
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
          <small>经营 / 催取 / 规程 · 操作需单独人工确认</small>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={onClose}>
          关闭
        </Button>
      </header>
      <div className="ld-ai-panel__messages" aria-live="polite">
        {aiPort.vision === undefined ? null : (
          <VisionPanel key={authSessionId} port={aiPort.vision} />
        )}
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
            <div
              key={message.id}
              className={`ld-ai-panel__message ld-ai-panel__message--${message.role}`}
            >
              <strong>
                {message.role === "user" ? "你" : message.role === "assistant" ? "AI" : "系统"}
              </strong>
              <span>{message.text || (busy && message.role === "assistant" ? "生成中…" : "")}</span>
              {message.preview === undefined ? null : (
                <AiOperationCard
                  key={`${authSessionId}:${message.preview.confirm_ref}`}
                  preview={message.preview}
                  port={aiPort}
                />
              )}
            </div>
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
