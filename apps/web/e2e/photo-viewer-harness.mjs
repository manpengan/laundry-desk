/** Real gallery and glass drawer; only the photo port uses local synthetic bytes. */
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Drawer } from "@laundry/ui";
import { PhotoGallery } from "../src/pages/PhotoGallery.tsx";
import "@laundry/ui/styles.css";
import "@laundry/ui/styles/components.css";
import "../src/styles/shell.css";

const photo = {
  photo_id: "11111111-1111-4111-8111-111111111111",
  order_id: "22222222-2222-4222-8222-222222222222",
  garment_id: "33333333-3333-4333-8333-333333333333",
  kind: "receive",
  content_type: "image/png",
  byte_size: 0,
  taken_at: 0,
};
const canvas = document.createElement("canvas");
canvas.width = 1200;
canvas.height = 1600;
const context = canvas.getContext("2d");
context.fillStyle = "#785c42";
context.fillRect(0, 0, canvas.width, canvas.height);
const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
const bytes = new Uint8Array(await blob.arrayBuffer());
const unavailable = async () => ({ ok: false, error: { code: "FIXTURE", message: "Unavailable" } });
const photoPort = {
  read: async () => ({ ok: true, data: { content_type: "image/png", bytes } }),
  upload: unavailable,
  remove: unavailable,
};

function Fixture() {
  const [open, setOpen] = useState(false);
  return createElement(
    "main",
    null,
    createElement("button", { onClick: () => setOpen(true) }, "打开订单"),
    createElement(
      Drawer,
      { open, title: "订单详情", onClose: () => setOpen(false) },
      createElement(PhotoGallery, {
        photos: [photo],
        photoPort,
        onDelete: async () => false,
      }),
    ),
  );
}
createRoot(document.getElementById("root")).render(createElement(Fixture));
