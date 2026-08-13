import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { OwnerAiSafetyView } from "./OwnerAiSafetyCard.js";

test("OwnerAiSafetyView exposes hard-off, integer usage, and safety controls", () => {
  const html = renderToStaticMarkup(
    createElement(OwnerAiSafetyView, {
      status: {
        runtime_enabled: false,
        pii_masking: true,
        egress_policy: "https_443_allowlist",
        month: "2026-08",
        input_tokens: 11,
        output_tokens: 7,
        estimated_cost_micros: 39,
        monthly_limit_micros: 500_000,
        remaining_micros: 499_961,
        circuit_state: "open",
        circuit_open_until: "2026-08-13T12:05:00.000Z",
      },
    }),
  );

  assert.match(html, /data-state="ready"/u);
  assert.match(html, /默认关闭/u);
  assert.match(html, /18 tokens/u);
  assert.match(html, /39 \/ 500000 微单位/u);
  assert.match(html, /已熔断/u);
  assert.match(html, /PII 脱敏开启 · HTTPS 443 白名单/u);
});
