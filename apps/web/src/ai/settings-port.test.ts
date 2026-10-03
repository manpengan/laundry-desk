import assert from "node:assert/strict";
import { test } from "node:test";
import { createAiSettingsPort, createHttpAiSettingsOperation } from "./settings-port.js";
import { createDesktopAiPanelPort } from "./desktop-ai-port.js";
import type { DesktopAiInput } from "@laundry/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AiSettingsPanel } from "./AiSettingsPanel.js";
import { createMockAuthClient } from "../auth/AuthClient.js";

const id = "11111111-1111-4111-8111-111111111111";
test("BYOK browser ingress requires CSRF, uses fixed POST and rejects secret-bearing replies", async () => {
  let calls = 0;
  let csrf: string | null = null;
  let request: RequestInit | undefined;
  const port = createAiSettingsPort(
    createHttpAiSettingsOperation({
      apiBaseUrl: "http://127.0.0.1:8787",
      getAccessToken: () => "main-memory-access",
      readCsrf: () => csrf,
      fetchImpl: async (url, init) => {
        calls++;
        request = init;
        assert.equal(url, "http://127.0.0.1:8787/api/v2/ai/provider-credentials/secret");
        return new Response(JSON.stringify({ ok: true, data: { api_key: "must-not-project" } }));
      },
    }),
  );
  assert.equal((await port.replace(id, id, "fixture-secret")).ok, false);
  assert.equal(calls, 0);
  csrf = "fixture-csrf";
  const result = await port.replace(id, id, "fixture-secret");
  assert.equal(calls, 1);
  assert.equal(request?.method, "POST");
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("must-not-project"), false);
});
test("credential validation uses server-frozen confirmation before activation", async () => {
  const calls: DesktopAiInput[] = [];
  const port = createAiSettingsPort(async (input) => {
    calls.push(input);
    if (input.operation === "validationIntent")
      return {
        ok: true,
        data: {
          confirm_ref: id,
          expires_at: 123,
          summary: {
            provider_code: "deepseek",
            credential_ref: id,
            credential_version: 1,
            credential_last4: "1234",
            model_id: "fixture",
          },
        },
      };
    return {
      ok: true,
      data: {
        outcome: "valid",
        provider_code: "deepseek",
        credential_ref: id,
        credential_version: 1,
        model_id: "fixture",
        discovered_model_count: 1,
        selected_model_available: true,
        error_code: null,
        validated_at: "2026-10-03T00:00:00Z",
      },
    };
  });
  assert.equal((await port.validate(id, "fixture")).ok, true);
  assert.deepEqual(
    calls.map((input) => input.operation),
    ["validationIntent", "validate"],
  );
  assert.deepEqual(calls[1], { operation: "validate", body: { confirm_ref: id } });
});
test("desktop AI abort reaches main and late output cannot update the panel", async () => {
  const calls: DesktopAiInput[] = [];
  let complete: (result: unknown) => void = () => undefined;
  const port = createDesktopAiPanelPort(async (input) => {
    calls.push(input);
    if (input.operation === "cancel") return { ok: true, data: { cancelled: true } };
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const abort = new AbortController();
  let rendered = 0;
  const pending = port.stream(id, 0, abort.signal, () => {
    rendered++;
  });
  abort.abort();
  complete({ ok: true, data: { events: [], cursor: 0 } });
  assert.equal((await pending).ok, false);
  assert.equal(rendered, 0);
  assert.equal(calls[1]?.operation, "cancel");
});
test("AI settings explains custody and requires explicit prices without storing keys", () => {
  const port = createAiSettingsPort(async () => null);
  const html = renderToStaticMarkup(
    createElement(AiSettingsPanel, { port, authClient: createMockAuthClient(), staffId: id }),
  );
  assert.match(html, /当前运行账户/u);
  assert.match(html, /每月预算/u);
  assert.match(html, /type="password"/u);
  assert.match(html, /autoComplete="off"/u);
  assert.match(html, /需复核/u);
  assert.doesNotMatch(html, /localStorage|sessionStorage/u);
});
