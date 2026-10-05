import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { CommandResult, QueryPort } from "../commands/types.js";
import type { CustomerRowView } from "./customer-model.js";
import { useCustomerSelection } from "./use-customer-selection.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const customer = (id: string, name = id): CustomerRowView => ({
  customer_id: id,
  phone: id === "A" ? "13800000001" : "13800000002",
  name,
  note: null,
  updated_at: 1,
});
function deferred() {
  let resolve!: (result: CommandResult<unknown>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CommandResult<unknown>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Pending = ReturnType<typeof deferred> & { name: string; body: unknown };
async function harness(deferHistory = false) {
  const pending: Pending[] = [];
  const messages: string[] = [];
  let renders = 0;
  let state!: ReturnType<typeof useCustomerSelection>;
  const queryClient: QueryPort = {
    async execute<T>(name: string, body?: unknown): Promise<CommandResult<T>> {
      if (name === "customer.get" || (deferHistory && name === "order.list")) {
        const item = { ...deferred(), name, body };
        pending.push(item);
        return item.promise as Promise<CommandResult<T>>;
      }
      return {
        ok: true,
        data: (name === "order.list"
          ? { orders: [], total: 0, offset: 0, limit: 20 }
          : { jobs: [] }) as T,
      };
    },
  };
  const notify = (message: string) => {
    messages.push(message);
  };
  function Probe() {
    renders += 1;
    state = useCustomerSelection({ queryClient, notify });
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(createElement(Probe));
  });
  return {
    pending,
    messages,
    renderer,
    get state() {
      return state;
    },
    get renders() {
      return renders;
    },
  };
}
const success = (row: CustomerRowView): CommandResult<unknown> => ({ ok: true, data: row });
const failure: CommandResult<unknown> = { ok: false, error: { code: "NETWORK" } };

for (const outcome of ["success", "failure", "invalid", "throw"] as const) {
  test(`slow A ${outcome} cannot replace fast B or change its error/loading state`, async () => {
    const h = await harness();
    try {
      let first!: Promise<void>, second!: Promise<void>;
      await act(() => {
        first = h.state.select(customer("A"));
      });
      await act(() => {
        second = h.state.select(customer("B"));
      });
      await act(async () => {
        h.pending[1]!.resolve(success(customer("B")));
        await second;
      });
      await act(async () => {
        if (outcome === "throw") h.pending[0]!.reject(new Error("old request failed"));
        else
          h.pending[0]!.resolve(
            outcome === "success"
              ? success(customer("A"))
              : outcome === "failure"
                ? failure
                : { ok: true, data: {} },
          );
        await first;
      });
      assert.equal(h.state.selected?.customer_id, "B");
      assert.equal(h.state.loading, false);
      assert.equal(h.state.error, null);
      assert.deepEqual(h.messages, []);
    } finally {
      await act(() => h.renderer.unmount());
    }
  });
}

test("A to B to A uses request generation, not customer id, and ignores stale finally", async () => {
  const h = await harness();
  try {
    let first!: Promise<void>, second!: Promise<void>, latest!: Promise<void>;
    await act(() => {
      first = h.state.select(customer("A"));
    });
    await act(() => {
      second = h.state.select(customer("B"));
    });
    await act(() => {
      latest = h.state.select(customer("A"));
    });
    await act(async () => {
      h.pending[0]!.resolve(success(customer("A", "旧 A")));
      await first;
    });
    assert.equal(h.state.selected, null);
    assert.equal(h.state.loading, true);
    await act(async () => {
      h.pending[1]!.resolve(failure);
      await second;
    });
    assert.equal(h.state.loading, true);
    assert.equal(h.state.error, null);
    await act(async () => {
      h.pending[2]!.resolve(success(customer("A", "新 A")));
      await latest;
    });
    assert.equal((h.state.selected as CustomerRowView | null)?.name, "新 A");
    assert.equal(h.state.loading, false);
  } finally {
    await act(() => h.renderer.unmount());
  }
});

for (const scope of ["close", "unmount"] as const) {
  for (const outcome of ["success", "failure", "throw"] as const) {
    test(`${scope} invalidates delayed detail ${outcome}`, async () => {
      const h = await harness();
      let request!: Promise<void>;
      await act(() => {
        request = h.state.select(customer("A"));
      });
      await act(() => {
        if (scope === "close") h.state.close();
        else h.renderer.unmount();
      });
      const before = h.renders;
      await act(async () => {
        if (outcome === "throw") h.pending[0]!.reject(new Error("late failure"));
        else h.pending[0]!.resolve(outcome === "success" ? success(customer("A")) : failure);
        await request;
      });
      assert.equal(h.renders, before);
      assert.equal(h.state.selected, null);
      assert.equal(h.state.error, null);
      assert.deepEqual(h.messages, []);
      if (scope === "close") await act(() => h.renderer.unmount());
      else {
        await h.state.select(customer("B"));
        assert.equal(h.pending.length, 1);
      }
    });
  }
}

test("old history error and finally cannot affect the newly selected customer's history", async () => {
  const h = await harness(true);
  try {
    let first!: Promise<void>, second!: Promise<void>;
    await act(() => {
      first = h.state.select(customer("A"));
    });
    await act(async () => {
      h.pending[0]!.resolve(success(customer("A")));
      await first;
    });
    await act(() => {
      second = h.state.select(customer("B"));
    });
    await act(async () => {
      h.pending[2]!.resolve(success(customer("B")));
      await second;
    });
    await act(async () => {
      h.pending[1]!.resolve(failure);
    });
    assert.equal(h.state.selected?.customer_id, "B");
    assert.equal(h.state.ordersBusy, true);
    assert.deepEqual(h.messages, []);
    await act(() => h.state.close());
    await act(async () => {
      h.pending[3]!.resolve({ ok: true, data: { orders: [], total: 0, offset: 0, limit: 20 } });
    });
    assert.equal(h.state.selected, null);
    assert.equal(h.state.ordersBusy, false);
  } finally {
    await act(() => h.renderer.unmount());
  }
});

test("a mismatched customer response remains closed and retry fetches the intended customer", async () => {
  const h = await harness();
  try {
    let request!: Promise<void>;
    await act(() => {
      request = h.state.select(customer("A"));
    });
    await act(async () => {
      h.pending[0]!.resolve(success(customer("B")));
      await request;
    });
    assert.equal(h.state.selected, null);
    assert.match(h.state.error ?? "", /返回格式无效/u);
    assert.equal(h.state.loading, false);
    await act(() => {
      request = h.state.retry();
    });
    assert.deepEqual(h.pending[1]!.body, { customer_id: "A" });
    await act(async () => {
      h.pending[1]!.resolve(success(customer("A")));
      await request;
    });
    assert.equal((h.state.selected as CustomerRowView | null)?.customer_id, "A");
    assert.equal(h.state.error, null);
  } finally {
    await act(() => h.renderer.unmount());
  }
});
