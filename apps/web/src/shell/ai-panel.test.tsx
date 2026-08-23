import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createMockConnection } from "../connection.js";
import { createUnavailableAiPanelPort } from "../host/ai-port.js";
import { AiPanel, drainStaleAiTurn } from "./AiPanel.js";
import { TopBar } from "./TopBar.js";

test("AI panel renders text-only generation, stop-ready controls, and unavailable copy", () => {
  const html = renderToStaticMarkup(
    <AiPanel
      open
      onClose={() => undefined}
      authSessionId="11111111-1111-4111-8111-111111111111"
      aiPort={createUnavailableAiPanelPort()}
    />,
  );
  assert.match(html, /AI 助手/iu);
  assert.match(html, /流式生成/iu);
  assert.match(html, /来源与筛选条件/iu);
  assert.match(html, /经营汇总|经营/iu);
  assert.match(html, /订单\/顾客/iu);
  assert.match(html, /规程/iu);
  assert.match(html, /未配置 AI 时会明确失败关闭/iu);
  assert.match(html, /textarea/iu);
  assert.match(html, /id="ld-ai-panel"/u);
  assert.match(html, /role="dialog"/u);
  assert.match(html, /data-testid="ai-panel"/u);
  assert.doesNotMatch(html, /dangerouslySetInnerHTML|innerHTML/iu);
});

test("AI panel stays unmounted while closed", () => {
  const html = renderToStaticMarkup(
    <AiPanel
      open={false}
      onClose={() => undefined}
      authSessionId="11111111-1111-4111-8111-111111111111"
      aiPort={createUnavailableAiPanelPort()}
    />,
  );
  assert.equal(html, "");
});

test("stale AI turns drain with a fresh live signal and no UI events", async () => {
  let signalWasAborted = true;
  let streamCalls = 0;
  const base = createUnavailableAiPanelPort();
  const drained = await drainStaleAiTurn(
    Object.freeze({
      ...base,
      stream: async (_sessionId, _after, signal) => {
        signalWasAborted = signal.aborted;
        streamCalls += 1;
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({ cursor: 1 }),
        });
      },
    }),
    "11111111-1111-4111-8111-111111111111",
    0,
  );
  assert.equal(drained, true);
  assert.equal(signalWasAborted, false);
  assert.equal(streamCalls, 1);
});

test("stale AI turn drain reports transport rejection", async () => {
  const base = createUnavailableAiPanelPort();
  const drained = await drainStaleAiTurn(
    Object.freeze({
      ...base,
      stream: async () => Promise.reject(new Error("transport rejected")),
    }),
    "11111111-1111-4111-8111-111111111111",
    0,
  );
  assert.equal(drained, false);
});

test("AI trigger exposes its collapsed and expanded state", () => {
  const render = (aiOpen: boolean): string =>
    renderToStaticMarkup(
      <TopBar
        connection={createMockConnection()}
        themePreference="system"
        onCycleTheme={() => undefined}
        aiOpen={aiOpen}
        onToggleAi={() => undefined}
      />,
    );

  assert.match(render(false), /aria-expanded="false"/u);
  assert.match(render(true), /aria-expanded="true"/u);
  assert.match(render(false), /aria-controls="ld-ai-panel"/u);
});

test("source aborts on stop/unmount and clears conversation when auth session changes", () => {
  const source = readFileSync(new URL("../../src/shell/AiPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /abortRef\.current\?\.abort\(\)/u);
  assert.match(source, /setConversationId\(null\)/u);
  assert.match(source, /setMessages\(Object\.freeze\(\[\]\)\)/u);
  assert.match(source, /\[authSessionId\]/u);
  assert.match(source, /event\.key === "Escape"/u);
  assert.match(source, /operationGenerationRef\.current \+= 1/u);
  assert.match(source, /if \(abortRef\.current === null\) return;/u);
  assert.match(source, /drainStaleAiTurn/u);
  assert.match(source, /正在建立 AI 回合/u);
  assert.match(source, /returnFocus\?\.isConnected === true/u);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML/u);
});

test("counter and owner AI entries toggle the current open state", () => {
  const counterSource = readFileSync(
    new URL("../../src/shell/CounterShellCore.tsx", import.meta.url),
    "utf8",
  );
  const ownerSource = readFileSync(
    new URL("../../src/owner/OwnerShell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(counterSource, /onToggleAi:\s*\(\) => setAiOpen\(\(value\) => !value\)/u);
  assert.match(ownerSource, /onClick=\{\(\) => setAiOpen\(\(value\) => !value\)\}/u);
});

test("AI panel uses the active light and dark theme tokens", () => {
  const source = readFileSync(new URL("../../src/styles/ai-panel.css", import.meta.url), "utf8");
  assert.match(source, /color:\s*var\(--lg-ink\)/u);
  assert.match(source, /background:\s*var\(--lg-surface\)/u);
  assert.match(source, /border-left:\s*1px solid var\(--lg-hair\)/u);
  assert.match(source, /color:\s*var\(--lg-ink2\)/u);
  assert.match(source, /color:\s*var\(--lg-late-ink\)/u);
  assert.doesNotMatch(source, /--lg-(?:text|card-bg|border|muted|danger)/u);
});
