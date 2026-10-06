import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ScaleReading } from "@laundry/contracts";
import type { ScalePort } from "../host/scale-port.js";
import { ScaleCapturePanel } from "./ScaleCapturePanel.js";
import { SCALE_PREFERENCES_KEY } from "./scale-preferences.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const config = { operation: "read", port: "COM7", baud: 9600, framing: "8N1" };
function stored(blocked = false) {
  const values = new Map<string, string>([[SCALE_PREFERENCES_KEY, JSON.stringify(config)]]);
  const previousWindow = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blocked) throw new Error("quota");
        values.set(key, value);
      },
    },
  });
  return {
    values,
    restore: () => {
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else Reflect.set(globalThis, "window", previousWindow);
    },
  };
}
function click(renderer: ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAllByType("button")
    .find((item) => item.children.join("") === label);
  assert.ok(node, label);
  (node.props.onClick as () => void)();
}
function reading(captured_at = Date.now()): ScaleReading {
  return {
    grams: 1250,
    basis: "net",
    port: "COM7",
    captured_at,
    protocol: "and-standard-ascii-v1",
  };
}
const scale: ScalePort = {
  ports: async () => ({ ok: true, data: ["COM3", "COM7"] }),
  read: async () => ({ ok: true, data: reading() }),
};

test("scale remembers connection preferences, keeps the selected discovered port and never persists weight", async () => {
  const saved = stored();
  let renderer!: ReactTestRenderer;
  let applied: ScaleReading | null = null;
  const onApply = (value: ScaleReading) => {
    applied = value;
    return true;
  };
  try {
    await act(async () => {
      renderer = create(<ScaleCapturePanel port={scale} disabled={false} onApply={onApply} />);
    });
    assert.equal(renderer.root.findByProps({ "aria-label": "电子秤串口" }).props.value, "COM7");
    assert.equal(renderer.root.findByProps({ "aria-label": "电子秤波特率" }).props.value, "9600");
    await act(async () => click(renderer, "刷新串口"));
    assert.equal(renderer.root.findByProps({ "aria-label": "电子秤串口" }).props.value, "COM7");
    await act(async () => click(renderer, "读取稳定重量"));
    assert.match(JSON.stringify(renderer.toJSON()), /1250/u);
    await act(async () => click(renderer, "记录到订单"));
    assert.ok(applied);
    await act(async () => click(renderer, "保存通信设置"));
    assert.deepEqual(JSON.parse(saved.values.get(SCALE_PREFERENCES_KEY) ?? "null"), config);
    assert.doesNotMatch(saved.values.get(SCALE_PREFERENCES_KEY) ?? "", /grams|captured_at|1250/u);
    await act(async () => renderer.unmount());
    await act(async () => {
      renderer = create(<ScaleCapturePanel port={scale} disabled={false} onApply={onApply} />);
    });
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /记录到订单|1250/u);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    saved.restore();
  }
});

test("storage write errors are visible and do not prevent a fresh reading", async () => {
  const saved = stored(true);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<ScaleCapturePanel port={scale} disabled={false} onApply={() => true} />);
    });
    await act(async () => click(renderer, "保存通信设置"));
    assert.match(JSON.stringify(renderer.toJSON()), /偏好设置保存失败/u);
    await act(async () => click(renderer, "读取稳定重量"));
    assert.match(JSON.stringify(renderer.toJSON()), /记录到订单/u);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    saved.restore();
  }
});

test("stale readings cannot be applied even before the expiry timer fires", async () => {
  const saved = stored();
  let renderer!: ReactTestRenderer;
  let applied = 0;
  let now = 1_000_000;
  const previousNow = Date.now;
  Date.now = () => now;
  try {
    await act(async () => {
      renderer = create(
        <ScaleCapturePanel
          port={scale}
          disabled={false}
          onApply={() => {
            applied++;
            return true;
          }}
        />,
      );
    });
    await act(async () => click(renderer, "读取稳定重量"));
    now += 30_001;
    await act(async () => click(renderer, "记录到订单"));
    assert.equal(applied, 0);
    assert.match(JSON.stringify(renderer.toJSON()), /读数已过期/u);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /记录到订单/u);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    Date.now = previousNow;
    saved.restore();
  }
});

test("replacing the scale scope or disabling it invalidates a pending reading", async () => {
  const saved = stored();
  let renderer!: ReactTestRenderer;
  let resolveRead!: (value: Awaited<ReturnType<ScalePort["read"]>>) => void;
  const oldScale: ScalePort = {
    ...scale,
    read: () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  };
  const onApply = () => true;
  try {
    await act(async () => {
      renderer = create(<ScaleCapturePanel port={oldScale} disabled={false} onApply={onApply} />);
    });
    await act(async () => click(renderer, "读取稳定重量"));
    await act(async () =>
      renderer.update(<ScaleCapturePanel port={scale} disabled={true} onApply={onApply} />),
    );
    await act(async () => resolveRead({ ok: true, data: reading() }));
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /记录到订单|1250/u);
    await act(async () =>
      renderer.update(<ScaleCapturePanel port={scale} disabled={false} onApply={onApply} />),
    );
    await act(async () => click(renderer, "读取稳定重量"));
    assert.match(JSON.stringify(renderer.toJSON()), /记录到订单/u);
    await act(async () => {
      const field = renderer.root.findByProps({ "aria-label": "电子秤数据格式" });
      (field.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "7E1" },
      });
    });
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /记录到订单/u);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    saved.restore();
  }
});

test("unavailable remembered port is not silently replaced by another device", async () => {
  const saved = stored();
  let renderer!: ReactTestRenderer;
  const missingPort: ScalePort = { ...scale, ports: async () => ({ ok: true, data: ["COM3"] }) };
  try {
    await act(async () => {
      renderer = create(
        <ScaleCapturePanel port={missingPort} disabled={false} onApply={() => true} />,
      );
    });
    await act(async () => click(renderer, "刷新串口"));
    assert.equal(renderer.root.findByProps({ "aria-label": "电子秤串口" }).props.value, "");
    assert.match(JSON.stringify(renderer.toJSON()), /串口当前不可用/u);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    saved.restore();
  }
});
