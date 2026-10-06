import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ToastProvider } from "@laundry/ui";
import type { CommandResult, QueryPort } from "../commands/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { CustomersPage } from "./CustomersPage.js";
import { DebtPage } from "./DebtPage.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const customer = {
  customer_id: "customer-a",
  phone_masked: "138****0001",
  name: "合成客户",
  updated_at: 1,
};
const order = {
  order_id: "order-a",
  ticket_no: "SYNTHETIC-1",
  status: "open",
  customer_phone: "13800000001",
  customer_name: "合成客户",
  payable_cents: 3000,
  paid_cents: 500,
  balance_cents: 2500,
  created_at: 1,
  garment_count: 1,
};
function click(renderer: ReactTestRenderer, testId: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.props["data-testid"] === testId);
  assert.ok(button, testId);
  (button.props.onClick as () => void)();
}
const rendered = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

for (const kind of ["customers", "debt"] as const) {
  for (const failure of ["api", "invalid", "throw"] as const) {
    test(`${kind} preserves rows through ${failure}, keeps its error during retry, and clears it only on success`, async () => {
      let mode: "failure" | "rows" | "pending" = "failure";
      let complete!: (result: CommandResult<unknown>) => void;
      const envelope = (empty: boolean): CommandResult<unknown> => ({
        ok: true,
        data:
          kind === "customers"
            ? { customers: empty ? [] : [customer] }
            : { orders: empty ? [] : [order], total: empty ? 0 : 1, offset: 0, limit: 50 },
      });
      const queryClient: QueryPort = {
        async execute<T>(): Promise<CommandResult<T>> {
          if (mode === "rows") return envelope(false) as CommandResult<T>;
          if (mode === "pending")
            return new Promise<CommandResult<unknown>>((resolve) => {
              complete = resolve;
            }) as Promise<CommandResult<T>>;
          if (failure === "throw") throw new Error("synthetic transport failure");
          return failure === "api"
            ? { ok: false, error: { code: "RESOURCE_UNAVAILABLE" } }
            : { ok: true, data: { unexpected: true } as T };
        },
      };
      const errorId = kind === "customers" ? "customers-search-error" : "debt-load-error";
      const loadId = kind === "customers" ? "customers-search-btn" : "debt-load-btn";
      const rowId = kind === "customers" ? "customers-row" : "debt-row";
      const emptyCopy = kind === "customers" ? "暂无匹配客户" : "暂无符合条件的订单";
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          createElement(
            ToastProvider,
            null,
            kind === "customers"
              ? createElement(CustomersPage, {
                  queryClient,
                  commandClient: createMockCommandClient(),
                })
              : createElement(DebtPage, { queryClient }),
          ),
        );
      });
      try {
        assert.match(rendered(renderer), new RegExp(errorId, "u"));
        assert.doesNotMatch(rendered(renderer), new RegExp(emptyCopy, "u"));
        mode = "rows";
        await act(async () => click(renderer, loadId));
        assert.match(rendered(renderer), new RegExp(rowId, "u"));
        assert.doesNotMatch(rendered(renderer), new RegExp(errorId, "u"));
        mode = "failure";
        await act(async () => click(renderer, loadId));
        assert.match(rendered(renderer), new RegExp(rowId, "u"));
        assert.match(rendered(renderer), /上次成功读取的结果/u);
        assert.doesNotMatch(rendered(renderer), new RegExp(emptyCopy, "u"));
        mode = "pending";
        await act(async () => {
          const notice = renderer.root.findByProps({ "data-testid": errorId });
          (notice.findByType("button").props.onClick as () => void)();
        });
        assert.match(rendered(renderer), new RegExp(errorId, "u"));
        assert.match(rendered(renderer), new RegExp(rowId, "u"));
        await act(async () => {
          complete(envelope(true));
        });
        assert.match(rendered(renderer), new RegExp(emptyCopy, "u"));
        assert.doesNotMatch(rendered(renderer), new RegExp(errorId, "u"));
      } finally {
        await act(async () => renderer.unmount());
      }
    });
  }
}
