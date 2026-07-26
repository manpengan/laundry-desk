import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Input } from "./Input.js";
import { Skeleton } from "./Skeleton.js";
import { Table } from "./Table.js";
import { ToastView } from "./Toast.js";

test("UI primitives render without inline style attributes", () => {
  const markup = [
    renderToStaticMarkup(
      createElement(Input, {
        label: "用户名",
        hint: "请输入员工账号",
        name: "username",
      }),
    ),
    renderToStaticMarkup(
      createElement(Skeleton, {
        className: "ld-skeleton--page-title",
      }),
    ),
    renderToStaticMarkup(
      createElement(ToastView, {
        item: { id: "toast-1", message: "保存成功", tone: "success" },
        onDismiss: () => undefined,
      }),
    ),
    renderToStaticMarkup(
      createElement(Table<{ id: string }>, {
        columns: [
          {
            key: "id",
            header: "编号",
            width: "40%",
            cell: (row) => row.id,
          },
        ],
        rows: [{ id: "A-1" }],
        rowKey: (row) => row.id,
      }),
    ),
  ].join("");

  assert.doesNotMatch(markup, /\sstyle=/u);
  assert.match(markup, /<col width="40%"\/>/u);
  assert.match(markup, /ld-skeleton--page-title/u);
});

test("empty tables use a CSP-safe spacing class", () => {
  const markup = renderToStaticMarkup(
    createElement(Table<{ id: string }>, {
      columns: [{ key: "id", header: "编号", cell: (row) => row.id }],
      rows: [],
      rowKey: (row) => row.id,
    }),
  );

  assert.doesNotMatch(markup, /\sstyle=/u);
  assert.match(markup, /ld-table-wrap--empty/u);
});
