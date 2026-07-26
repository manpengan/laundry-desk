import assert from "node:assert/strict";
import test from "node:test";

import type { LaundryDesktopBridge } from "./desktop-ports.js";
import { selectHost } from "./select-ports.js";

function createBridge(): LaundryDesktopBridge {
  return {
    auth: {
      login: async () => ({ ok: false }),
      pinChallenge: async () => ({ ok: false }),
      pinVerify: async () => ({ ok: false }),
    },
    command: {
      execute: async () => ({ ok: false }),
    },
    query: {
      execute: async () => ({ ok: false }),
    },
    health: {
      get: async () => ({ ok: false }),
    },
  };
}

test("selectHost sends HTTP and HTTPS hosts to browser ports", () => {
  assert.deepEqual(selectHost("http://127.0.0.1:5173/orders", undefined), {
    kind: "browser",
  });
  assert.deepEqual(selectHost("https://laundry.test/", createBridge()), {
    kind: "browser",
  });
});

test("selectHost accepts only the normalized app://local authority with a valid bridge", () => {
  const bridge = createBridge();
  const selection = selectHost("app://LOCAL/index.html?mode=desktop#root", bridge);

  assert.equal(selection.kind, "desktop");
  if (selection.kind === "desktop") {
    assert.equal(selection.bridge, bridge);
  }
});

test("selectHost rejects untrusted app authorities and URL credentials", () => {
  const bridge = createBridge();
  const untrusted = [
    "app://local.evil/index.html",
    "app://local./index.html",
    "app://local@evil/index.html",
    "app://user@local/index.html",
    "app://user:password@local/index.html",
    "app://local:443/index.html",
  ];

  for (const href of untrusted) {
    assert.throws(() => selectHost(href, bridge), /不受信任的桌面应用来源/u);
  }
});

test("selectHost fails closed when app://local has no valid desktop bridge", () => {
  const invalidBridges: readonly unknown[] = [
    undefined,
    null,
    {},
    { auth: {}, command: {}, query: {}, health: {} },
    { ...createBridge(), fetch: async () => new Response() },
    {
      ...createBridge(),
      command: {
        ...createBridge().command,
        invoke: async () => ({ ok: true }),
      },
    },
  ];

  for (const bridge of invalidBridges) {
    assert.throws(() => selectHost("app://local/index.html", bridge), /桌面安全桥未就绪/u);
  }
});

test("selectHost rejects accessor-backed bridge namespaces without evaluating them", () => {
  const valid = createBridge();
  let authGetterCalls = 0;
  const accessorBridge = Object.defineProperties(
    {},
    {
      auth: {
        enumerable: true,
        get: () => {
          authGetterCalls += 1;
          return valid.auth;
        },
      },
      command: { enumerable: true, value: valid.command },
      query: { enumerable: true, value: valid.query },
      health: { enumerable: true, value: valid.health },
    },
  );

  assert.throws(() => selectHost("app://local/index.html", accessorBridge), /桌面安全桥未就绪/u);
  assert.equal(authGetterCalls, 0);
});

test("selectHost fails closed for malformed URLs and unsupported protocols", () => {
  assert.throws(() => selectHost("not a URL", undefined), /宿主地址无效/u);
  assert.throws(
    () => selectHost("file:///Applications/laundry/index.html", undefined),
    /不支持的 Web 宿主协议/u,
  );
  assert.throws(() => selectHost("ftp://local/index.html", undefined), /不支持的 Web 宿主协议/u);
});
