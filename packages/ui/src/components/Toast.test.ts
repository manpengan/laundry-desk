import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ToastProvider, useToast, useToastPageScope } from "./Toast.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function Page({ pageKey, message }: Readonly<{ pageKey: string; message: string | null }>) {
  const toast = useToast();
  useToastPageScope(pageKey);
  useEffect(() => {
    if (message !== null) toast.push(message, "success");
  }, [message, toast]);
  return null;
}
const texts = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) => node.props.role === "status").map((node) => node.props);

test("a page change drops the previous page's toasts but keeps the one its action raised", async () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  try {
    let renderer!: ReactTestRenderer;
    const render = (pageKey: string, message: string | null) =>
      createElement(ToastProvider, null, createElement(Page, { pageKey, message }));
    await act(() => {
      renderer = create(render("staff", "员工已保存"));
    });
    assert.equal(texts(renderer).length, 1);
    mock.timers.tick(2_000);
    // Navigating away clears the stale toast…
    await act(() => {
      renderer.update(render("accounting", null));
    });
    assert.equal(texts(renderer).length, 0);
    // …while a toast raised together with the navigation survives it.
    await act(() => {
      renderer.update(render("pickup", "取衣完成"));
    });
    assert.equal(texts(renderer).length, 1);
    mock.timers.tick(4_000);
    await act(async () => undefined);
    assert.equal(texts(renderer).length, 0);
    await act(() => renderer.unmount());
  } finally {
    mock.timers.reset();
  }
});

test("the page scope is a no-op outside a provider", async () => {
  function Bare() {
    useToastPageScope("orders");
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(createElement(Bare));
  });
  await act(() => renderer.unmount());
});
