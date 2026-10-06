import assert from "node:assert/strict";
import test from "node:test";
import { OrderReceiveInputSchema, ReceiveRecoveryDraftSchema } from "@laundry/contracts";
import { applyCatalogPick } from "./ReceiveLineEditor.js";
import { buildReceiveBody, newLineDraft } from "./order-form.js";
import { createReceiveWorkspace } from "./receive-workspace.js";

test("chosen catalog identity survives form, command and encrypted draft without trusting its name", () => {
  const selected = applyCatalogPick([newLineDraft(0)], null, {
    code: "cashmere-coat",
    name: "羊绒大衣",
    service_code: "wash",
    category_code: "coat",
    unit_price_cents: 3000,
  });
  const built = buildReceiveBody({
    customer_phone: "",
    customer_name: "",
    initial_payment_cents: "0",
    initial_payment_method: "cash",
    discount_cents: "0",
    urgent: false,
    freight: false,
    note: "",
    lines: selected.lines,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const request = OrderReceiveInputSchema.parse(built.body);
  assert.equal(request.lines[0]?.catalog_code, "cashmere-coat");
  assert.equal("catalog_name" in request.lines[0]!, false);
  assert.equal(built.previewLines[0]?.catalog_code, "cashmere-coat");
  assert.equal(built.previewLines[0]?.catalog_name, "羊绒大衣");
  const state = createReceiveWorkspace().getSnapshot();
  const draft = ReceiveRecoveryDraftSchema.parse({
    operationId: state.operationId,
    phone: "",
    name: "",
    paymentCents: "0",
    paymentMethod: "cash",
    pricing: state.pricing,
    note: "",
    draftId: null,
    lines: selected.lines,
    dirty: true,
  });
  assert.equal(draft.lines[0]?.catalog_code, "cashmere-coat");
  assert.equal(draft.lines[0]?.catalog_name, "羊绒大衣");
});
