import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createMockAuthClient } from "../auth/AuthClient.js";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { FulfillmentPage } from "./FulfillmentPage.js";

import {
  parseFulfillmentRows,
  transitionCommandForCount,
  unwrapFulfillmentResult,
} from "./fulfillment-model.js";

const ROW = Object.freeze({
  garment_id: "11111111-1111-4111-8111-111111111111",
  order_id: "22222222-2222-4222-8222-222222222222",
  ticket_no: "20260730-0001",
  barcode: "ABC123",
  customer_name: "张三",
  customer_phone_masked: "138****0111",
  service_code: "wash",
  category_code: "shirt",
  color: "白色",
  brand: null,
  status: "washing",
  rack_zone: null,
  rack_slot: null,
  updated_at: 1_722_297_600,
  incident_count: 0,
});

const SESSION: SessionView = Object.freeze({
  session: Object.freeze({
    session_id: "aaaaaaaa-bbbb-4ccc-8ddd-111111111111",
    session_version: 1,
    org_id: "aaaaaaaa-bbbb-4ccc-8ddd-222222222222",
    store_id: "aaaaaaaa-bbbb-4ccc-8ddd-333333333333",
    staff_id: "11111111-1111-4111-8111-111111111101",
    device_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    permission_version: 1,
  }),
  role: "admin",
  features: FULL_STORE_FEATURES,
  display: Object.freeze({
    store_name: "Windows 走查店",
    staff_name: "店员",
    org_code: "ORG",
    store_code: "S1",
  }),
});

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const body = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "u").exec(css)?.groups?.body;
  assert.ok(body, `missing CSS rule for ${selector}`);
  return body;
}

function cssBlock(css: string, header: string): string {
  const headerIndex = css.indexOf(header);
  assert.notEqual(headerIndex, -1, `missing CSS block for ${header}`);
  const openIndex = css.indexOf("{", headerIndex);
  assert.notEqual(openIndex, -1, `missing opening brace for ${header}`);

  let depth = 0;
  for (let index = openIndex; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(openIndex + 1, index);
  }

  assert.fail(`missing closing brace for ${header}`);
}

type CssSpecificity = readonly [ids: number, classes: number, elements: number];

function selectorSpecificity(selector: string): CssSpecificity {
  const ids = selector.match(/#[\w-]+/gu)?.length ?? 0;
  const pseudoElements = selector.match(/::[\w-]+/gu)?.length ?? 0;
  const withoutPseudoElements = selector.replace(/::[\w-]+/gu, " ");
  const classes = withoutPseudoElements.match(/(?:\.[\w-]+|\[[^\]]+\]|:[\w-]+)/gu)?.length ?? 0;
  const elements = withoutPseudoElements
    .replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+|\*/gu, " ")
    .split(/[\s>+~]+/u)
    .filter(Boolean).length;

  return [ids, classes, elements + pseudoElements];
}

function compareSpecificity(left: CssSpecificity, right: CssSpecificity): number {
  const [leftIds, leftClasses, leftElements] = left;
  const [rightIds, rightClasses, rightElements] = right;

  return leftIds - rightIds || leftClasses - rightClasses || leftElements - rightElements;
}

test("fulfillment parser accepts masked bounded workbench rows", () => {
  const parsed = parseFulfillmentRows(unwrapFulfillmentResult({ result: { garments: [ROW] } }));
  assert.equal(parsed?.length, 1);
  assert.equal(parsed?.[0]?.status, "washing");
  assert.equal(parsed?.[0]?.customer_phone_masked, "138****0111");
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed?.[0]), true);
});

test("fulfillment parser rejects unknown status and unsafe counters", () => {
  assert.equal(parseFulfillmentRows({ garments: [{ ...ROW, status: "unknown" }] }), null);
  assert.equal(
    parseFulfillmentRows({ garments: [{ ...ROW, incident_count: Number.MAX_SAFE_INTEGER + 1 }] }),
    null,
  );
});

test("single and batch transitions use separate risk contracts", () => {
  assert.equal(transitionCommandForCount(1), "garment.transition");
  assert.equal(transitionCommandForCount(2), "garment.bulk_transition");
  assert.equal(transitionCommandForCount(50), "garment.bulk_transition");
});

test("production controls expose complete labels and selection feedback", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(FulfillmentPage, {
        queryClient: createMockQueryClient(),
        commandClient: createMockCommandClient(),
        authClient: createMockAuthClient(),
        session: SESSION,
      }),
    ),
  );

  assert.match(html, /class="ld-fulfillment__select-field"[^>]*><span>状态<\/span><select/u);
  assert.match(html, /<span>异常类型<\/span><select/u);
  assert.match(html, /<strong aria-live="polite">已选 0 件<\/strong>/u);
});

test("fulfillment focus ring outranks the later shell-wide default", async () => {
  const [fulfillmentCss, shellCss] = await Promise.all([
    readFile(new URL("../../src/styles/fulfillment.css", import.meta.url), "utf8"),
    readFile(new URL("../../src/styles/shell.css", import.meta.url), "utf8"),
  ]);
  const fulfillmentSelector = ".ld-shell .ld-fulfillment :focus-visible";
  const shellSelector = ".ld-shell *:focus-visible";
  const fulfillmentImportIndex = shellCss.indexOf('@import "./fulfillment.css";');
  const shellRuleIndex = shellCss.indexOf(`${shellSelector} {`);

  assert.notEqual(fulfillmentImportIndex, -1, "shell must import the fulfillment stylesheet");
  assert.notEqual(shellRuleIndex, -1, "shell must define its shared focus ring");
  assert.ok(
    fulfillmentImportIndex < shellRuleIndex,
    "the imported fulfillment rule is evaluated before the shell-wide focus rule",
  );
  assert.ok(
    compareSpecificity(
      selectorSpecificity(fulfillmentSelector),
      selectorSpecificity(shellSelector),
    ) > 0,
    "the earlier fulfillment selector must be more specific than the shell-wide selector",
  );
  assert.match(cssRule(fulfillmentCss, fulfillmentSelector), /outline:\s*3px solid/u);

  const forcedColors = cssBlock(fulfillmentCss, "@media (forced-colors: active)");
  assert.match(cssRule(forcedColors, fulfillmentSelector), /outline-color:\s*Highlight/u);
});

test("production stylesheet keeps Windows alignment and clipping guards", async () => {
  const css = await readFile(new URL("../../src/styles/fulfillment.css", import.meta.url), "utf8");

  assert.match(cssRule(css, ".ld-fulfillment__select-field"), /flex-direction:\s*column/u);
  assert.match(cssRule(css, ".ld-fulfillment__actions"), /align-items:\s*center/u);
  assert.match(cssRule(css, ".ld-fulfillment__row > *"), /min-width:\s*0/u);
  assert.doesNotMatch(
    css,
    /--lg-(?:background|border|danger|success|surface-elevated|text(?:-secondary)?)(?:\W|$)/u,
  );
});
