import assert from "node:assert/strict";
import test from "node:test";

import {
  LOGIN_MEMORY_KEY,
  parseLoginWorkspace,
  readLoginWorkspace,
  rememberLoginWorkspace,
} from "../auth/login-memory.js";
import {
  catalogServices,
  functionKeyForTab,
  serviceForFunctionKey,
  serviceLabel,
} from "./catalog-services.js";
import { isVirtualPrinterQueue, printerQueueLabel, suggestReceiptQueue } from "./printer-queues.js";
import { insertToken } from "./ReminderTemplateEditor.js";
import { mayHandOffFocus, shouldClaimFocus } from "./use-scan-focus.js";
import { isAdvanceFromCustomer, isSubmitChord } from "./use-receive-keyboard.js";

test("scan pages claim focus only from navigation, never from a clerk's control", () => {
  const body = { closest: () => null };
  const doc = { body, documentElement: { closest: () => null } };
  const root = { ownerDocument: doc };
  const within = (match: string) => ({
    closest: (selector: string) => (selector.includes(match) ? {} : null),
  });
  assert.equal(shouldClaimFocus(null, root, false), true);
  assert.equal(shouldClaimFocus(body, root, false), true);
  assert.equal(shouldClaimFocus(within("ld-shell-sidebar"), root, false), true, "rail click");
  assert.equal(shouldClaimFocus(within("ld-shell-command"), root, false), true, "Ctrl+K trigger");
  assert.equal(
    shouldClaimFocus(within("ld-shell-topbar"), root, false),
    false,
    "AI / print / staff",
  );
  assert.equal(shouldClaimFocus(within("nothing"), root, false), false, "typing elsewhere");
  assert.equal(shouldClaimFocus(body, root, true), false, "modal open");
});

test("a finished pickup lookup never pulls the caret out of a field being typed in", () => {
  const field = (name: string | null, typing = true) => ({
    matches: () => typing,
    getAttribute: () => name,
  });
  const scan = ["pickup-key", "pickup-verification-barcode"];
  assert.equal(mayHandOffFocus(null, scan), true, "nothing focused");
  assert.equal(mayHandOffFocus(field(null, false), scan), true, "a button or the page body");
  assert.equal(mayHandOffFocus(field("pickup-key"), scan), true, "scan → verification");
  assert.equal(mayHandOffFocus(field("collect-cents"), scan), false, "clerk typing 本次收款");
  assert.equal(mayHandOffFocus(field(null), scan), false, "unnamed text field");
});

test("开单 keyboard flow: Ctrl+Enter submits, Enter in customer fields advances", () => {
  const key = { key: "Enter", ctrlKey: false, metaKey: false, altKey: false, isComposing: false };
  assert.equal(isSubmitChord({ ...key, ctrlKey: true }), true);
  assert.equal(isSubmitChord({ ...key, metaKey: true }), true);
  assert.equal(isSubmitChord(key), false);
  assert.equal(isSubmitChord({ ...key, ctrlKey: true, isComposing: true }), false);
  assert.equal(isAdvanceFromCustomer(key, "customer-phone"), true);
  assert.equal(isAdvanceFromCustomer(key, "customer-name"), true);
  assert.equal(isAdvanceFromCustomer(key, "note"), false);
  assert.equal(isAdvanceFromCustomer({ ...key, ctrlKey: true }, "customer-phone"), false);
  assert.equal(isAdvanceFromCustomer({ ...key, isComposing: true }, "customer-phone"), false);
});

test("service tabs keep first-seen order and map F1 = 全部, F2… = services", () => {
  const services = catalogServices([
    { service_code: "dry" },
    { service_code: "wash" },
    { service_code: "dry" },
    { service_code: " " },
  ]);
  assert.deepEqual(services, ["dry", "wash"]);
  assert.equal(serviceLabel("WASH"), "水洗");
  assert.equal(serviceLabel("custom_x"), "custom_x");
  assert.equal(serviceForFunctionKey("F1", services), "all");
  assert.equal(serviceForFunctionKey("F2", services), "dry");
  assert.equal(serviceForFunctionKey("F3", services), "wash");
  assert.equal(serviceForFunctionKey("F4", services), null);
  assert.equal(serviceForFunctionKey("F12", services), null);
  assert.equal(serviceForFunctionKey("Enter", services), null);
  assert.equal(functionKeyForTab(0), "F1");
  assert.equal(functionKeyForTab(10), "F11");
  assert.equal(functionKeyForTab(11), undefined);
});

test("printer preselection never defaults to Fax / PDF / XPS queues", () => {
  assert.equal(isVirtualPrinterQueue("Fax"), true);
  assert.equal(isVirtualPrinterQueue("Microsoft Print to PDF"), true);
  assert.equal(isVirtualPrinterQueue("Microsoft XPS Document Writer"), true);
  assert.equal(isVirtualPrinterQueue("XP-58"), false);
  const queues = [
    "Fax",
    "Microsoft Print to PDF",
    "OneNote (Desktop)",
    "XP-58 (copy 1)",
    "HP LaserJet",
  ];
  assert.equal(suggestReceiptQueue(null, queues), "XP-58 (copy 1)");
  assert.equal(suggestReceiptQueue("HP LaserJet", queues), "HP LaserJet");
  assert.equal(suggestReceiptQueue(null, ["Fax", "Microsoft Print to PDF"]), "");
  assert.equal(suggestReceiptQueue(null, ["Fax", "EPSON TM-T82"]), "EPSON TM-T82");
  assert.equal(suggestReceiptQueue("Removed", ["Fax"]), "");
  assert.equal(printerQueueLabel("Fax"), "Fax（非小票机）");
  assert.equal(printerQueueLabel("XP-58"), "XP-58");
});

test("login remembers only well-formed workspace codes", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  rememberLoginWorkspace(storage, { org_code: " local ", store_code: "main" });
  assert.deepEqual(readLoginWorkspace(storage), { org_code: "local", store_code: "main" });
  assert.doesNotMatch(values.get(LOGIN_MEMORY_KEY) ?? "", /password|username/u);
  rememberLoginWorkspace(storage, { org_code: "bad code", store_code: "main" });
  assert.deepEqual(readLoginWorkspace(storage), { org_code: "local", store_code: "main" });
  assert.equal(parseLoginWorkspace("{"), null);
  assert.equal(parseLoginWorkspace('{"org_code":1,"store_code":"x"}'), null);
  assert.equal(readLoginWorkspace(null), null);
});

test("template variables are inserted at the caret, replacing a selection", () => {
  assert.deepEqual(insertToken("您好，", "{{tickets}}", 3, 3), {
    text: "您好，{{tickets}}",
    caret: 14,
  });
  assert.deepEqual(insertToken("尚欠X分", "{{balance_cents}}", 2, 3), {
    text: "尚欠{{balance_cents}}分",
    caret: 19,
  });
  assert.deepEqual(insertToken("ab", "{{x}}", 99, 99), { text: "ab{{x}}", caret: 7 });
});
