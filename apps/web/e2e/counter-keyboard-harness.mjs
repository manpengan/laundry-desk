/** Real components with synthetic catalog responses; no server or customer data. */
import { createElement as h, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Drawer } from "@laundry/ui";
import { CatalogPicker } from "../src/pages/CatalogPicker.tsx";
import { useReceiveKeyboard } from "../src/pages/use-receive-keyboard.ts";
import "@laundry/ui/styles.css";
import "@laundry/ui/styles/components.css";

const catalog = [
  {
    code: "D",
    name: "干洗大衣",
    service_code: "dry",
    category_code: "coat",
    unit_price_cents: 1000,
  },
  {
    code: "W",
    name: "水洗衬衫",
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: 500,
  },
];
const queryClient = {
  async execute(_name, body) {
    const items = catalog.filter((item) => item.name.includes(body.query));
    return { ok: true, data: { items, total: items.length } };
  },
};

function App() {
  const rootRef = useRef(null);
  const [picked, setPicked] = useState(0);
  const [submitted, setSubmitted] = useState(0);
  const [open, setOpen] = useState(false);
  useReceiveKeyboard(rootRef, { canSubmit: true, onSubmit: () => setSubmitted((n) => n + 1) });
  return h(
    "main",
    { ref: rootRef },
    h(CatalogPicker, { queryClient, onPick: () => setPicked((n) => n + 1) }),
    h("output", { "data-testid": "picked" }, picked),
    h("output", { "data-testid": "submitted" }, submitted),
    h("button", { onClick: () => setOpen(true) }, "打开订单详情"),
    h(
      Drawer,
      { open, title: "订单详情", onClose: () => setOpen(false) },
      h("button", null, "前置按钮"),
      h(
        "details",
        null,
        h("summary", null, "更多信息"),
        h("button", null, "详情内按钮"),
        h("details", null, h("summary", null, "嵌套详情"), h("button", null, "嵌套内按钮")),
      ),
      h("button", null, "上传照片"),
      h(
        "details",
        null,
        h("summary", { tabIndex: -1 }, "仅鼠标展开"),
        h("button", null, "末尾隐藏按钮"),
      ),
    ),
  );
}

createRoot(document.getElementById("root")).render(h(App));
