import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment, useState, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { MoneyInput } from "./MoneyInput.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  return renderer;
}

test("MoneyInput follows programmatic prop loads and resets", async () => {
  const onChangeFen = () => undefined;
  const renderer = await mount(createElement(MoneyInput, { valueFen: "0", onChangeFen }));

  try {
    assert.equal(renderer.root.findByType("input").props.value, "0.00");

    await act(async () => {
      renderer.update(createElement(MoneyInput, { valueFen: "1500", onChangeFen }));
    });
    assert.equal(renderer.root.findByType("input").props.value, "15.00");

    await act(async () => {
      renderer.update(createElement(MoneyInput, { valueFen: "0", onChangeFen }));
    });
    assert.equal(renderer.root.findByType("input").props.value, "0.00");
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("MoneyInput preserves partial text, forwards blur and follows a controlled reset", async () => {
  let blurEvent: unknown;

  function ControlledMoneyInput() {
    const [fen, setFen] = useState("1500");
    return createElement(
      Fragment,
      null,
      createElement(MoneyInput, {
        valueFen: fen,
        onChangeFen: setFen,
        onBlur: (event) => {
          blurEvent = event;
        },
      }),
      createElement("output", null, fen),
      createElement("button", { onClick: () => setFen("0") }, "reset"),
    );
  }

  const renderer = await mount(createElement(ControlledMoneyInput));
  try {
    const partialEvent = { target: { value: "15." } };
    await act(async () => {
      renderer.root.findByType("input").props.onChange(partialEvent);
    });
    assert.equal(renderer.root.findByType("input").props.value, "15.");
    assert.deepEqual(renderer.root.findByType("output").children, []);

    await act(async () => {
      renderer.root.findByType("input").props.onChange({ target: { value: "15.00" } });
    });
    assert.equal(renderer.root.findByType("input").props.value, "15.00");
    assert.deepEqual(renderer.root.findByType("output").children, ["1500"]);

    const forwardedBlurEvent = { target: { value: "15.00" } };
    await act(async () => {
      renderer.root.findByType("input").props.onBlur(forwardedBlurEvent);
    });
    assert.equal(blurEvent, forwardedBlurEvent);

    await act(async () => {
      renderer.root.findByType("button").props.onClick();
    });
    assert.equal(renderer.root.findByType("input").props.value, "0.00");
    assert.deepEqual(renderer.root.findByType("output").children, ["0"]);
  } finally {
    await act(async () => renderer.unmount());
  }
});
