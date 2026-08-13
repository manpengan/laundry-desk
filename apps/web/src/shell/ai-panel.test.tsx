import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createUnavailableAiPanelPort } from "../host/ai-port.js";
import { AiPanel } from "./AiPanel.js";

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
  assert.doesNotMatch(html, /dangerouslySetInnerHTML|innerHTML/iu);
});

test("source aborts on stop/unmount and clears conversation when auth session changes", () => {
  const source = readFileSync(new URL("../../src/shell/AiPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /abortRef\.current\?\.abort\(\)/u);
  assert.match(source, /setConversationId\(null\)/u);
  assert.match(source, /setMessages\(Object\.freeze\(\[\]\)\)/u);
  assert.match(source, /\[authSessionId\]/u);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML/u);
});
