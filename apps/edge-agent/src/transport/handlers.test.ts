import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DESKTOP_IPC_CHANNELS } from "../lib/security-prefs.js";
import {
  registerDesktopOperationHandlers,
  type DesktopIpcEventSurface,
  type DesktopIpcMainSurface,
  type DesktopOperationService,
} from "./handlers.js";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..", "src");

const SAFE_FAILURE = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    code: "RESOURCE_UNAVAILABLE" as const,
    message: "Resource is unavailable" as const,
  }),
});

function createService(overrides: Partial<DesktopOperationService> = {}): DesktopOperationService {
  return {
    auth:
      overrides.auth ??
      Object.freeze({
        login: async () => SAFE_FAILURE,
        refresh: async () => SAFE_FAILURE,
        pinChallenge: async () => SAFE_FAILURE,
        pinVerify: async () => SAFE_FAILURE,
        logout: async () => SAFE_FAILURE,
      }),
    command:
      overrides.command ??
      Object.freeze({
        execute: async () => SAFE_FAILURE,
      }),
    query:
      overrides.query ??
      Object.freeze({
        execute: async () => SAFE_FAILURE,
      }),
    photo:
      overrides.photo ??
      Object.freeze({
        upload: async () => SAFE_FAILURE,
        read: async () => SAFE_FAILURE,
        delete: async () => SAFE_FAILURE,
      }),
    offline:
      overrides.offline ??
      Object.freeze({
        resume: async () => SAFE_FAILURE,
        status: async () => SAFE_FAILURE,
        resolve: async () => SAFE_FAILURE,
      }),
    health:
      overrides.health ??
      Object.freeze({
        get: async () => SAFE_FAILURE,
      }),
  };
}

function createHarness(service: DesktopOperationService = createService()) {
  const handlers = new Map<
    string,
    (event: DesktopIpcEventSurface, ...arguments_: readonly unknown[]) => Promise<unknown>
  >();
  const ipcMain: DesktopIpcMainSurface = {
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false);
      handlers.set(channel, handler);
    },
  };
  let errors: readonly Readonly<{ channel: string; errorName: string }>[] = [];
  registerDesktopOperationHandlers({
    ipcMain,
    service,
    expectedWebContentsId: () => 17,
    reportError: (error) => {
      errors = Object.freeze([...errors, error]);
    },
  });
  return Object.freeze({
    handlers,
    get errors(): readonly Readonly<{ channel: string; errorName: string }>[] {
      return errors;
    },
  });
}

function sender(
  input: Readonly<{
    senderId?: number;
    url?: string;
    mainFrame?: boolean;
  }> = {},
): DesktopIpcEventSurface {
  const frame = Object.freeze({ url: input.url ?? "app://local/index.html" });
  return Object.freeze({
    sender: Object.freeze({
      id: input.senderId ?? 17,
      mainFrame: frame,
    }),
    senderFrame: input.mainFrame === false ? Object.freeze({ url: frame.url }) : frame,
  });
}

function getHandler(
  harness: ReturnType<typeof createHarness>,
  channel: string,
): (event: DesktopIpcEventSurface, ...arguments_: readonly unknown[]) => Promise<unknown> {
  const handler = harness.handlers.get(channel);
  if (handler === undefined) throw new Error(`missing test handler: ${channel}`);
  return handler;
}

test("registers exactly the fixed desktop capability channels", () => {
  const harness = createHarness();
  assert.deepEqual(
    [...harness.handlers.keys()],
    [
      DESKTOP_IPC_CHANNELS.auth.login,
      DESKTOP_IPC_CHANNELS.auth.refresh,
      DESKTOP_IPC_CHANNELS.auth.pinChallenge,
      DESKTOP_IPC_CHANNELS.auth.pinVerify,
      DESKTOP_IPC_CHANNELS.auth.logout,
      DESKTOP_IPC_CHANNELS.command.execute,
      DESKTOP_IPC_CHANNELS.query.execute,
      DESKTOP_IPC_CHANNELS.photo.upload,
      DESKTOP_IPC_CHANNELS.photo.read,
      DESKTOP_IPC_CHANNELS.photo.delete,
      DESKTOP_IPC_CHANNELS.offline.resume,
      DESKTOP_IPC_CHANNELS.offline.status,
      DESKTOP_IPC_CHANNELS.offline.resolve,
      DESKTOP_IPC_CHANNELS.health.get,
    ],
  );
});

test("validates photo bytes before invoking the named service", async () => {
  const captured: unknown[] = [];
  const harness = createHarness(
    createService({
      photo: Object.freeze({
        upload: async (input: unknown) => {
          captured.push(input);
          return SAFE_FAILURE;
        },
        read: async () => SAFE_FAILURE,
        delete: async () => SAFE_FAILURE,
      }),
    }),
  );
  const invoke = getHandler(harness, DESKTOP_IPC_CHANNELS.photo.upload);
  const valid = {
    upload_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    garment_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    kind: "receive",
    content_type: "image/jpeg",
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
  };

  assert.deepEqual(await invoke(sender(), valid), SAFE_FAILURE);
  assert.equal(captured.length, 1);
  await assert.rejects(
    () => invoke(sender(), { ...valid, url: "https://attacker.invalid" }),
    /Desktop operation rejected/u,
  );
  assert.equal(captured.length, 1);
});

test("main wires the fixed Electron adapter and handlers without exporting token access", () => {
  const main = readFileSync(join(sourceRoot, "main.ts"), "utf8");
  const preload = readFileSync(join(sourceRoot, "preload.ts"), "utf8");

  assert.match(main, /createElectronDesktopDependencies/u);
  assert.match(main, /createDesktopHttpTransport/u);
  assert.match(main, /registerDesktopOperationHandlers/u);
  assert.match(main, /expectedWebContentsId/u);
  assert.doesNotMatch(preload, /getAccessToken|authorization|cookies?|headers?|fetch/u);
});

test("validates a login before invoking the main-only service", async () => {
  const captured: unknown[] = [];
  const harness = createHarness(
    createService({
      auth: Object.freeze({
        login: async (input) => {
          captured.push(input);
          return SAFE_FAILURE;
        },
        refresh: async () => SAFE_FAILURE,
        pinChallenge: async () => SAFE_FAILURE,
        pinVerify: async () => SAFE_FAILURE,
        logout: async () => SAFE_FAILURE,
      }),
    }),
  );
  const input = Object.freeze({
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "secret",
  });

  const result = await getHandler(harness, DESKTOP_IPC_CHANNELS.auth.login)(sender(), input);

  assert.deepEqual(result, SAFE_FAILURE);
  assert.deepEqual(captured, [input]);
  assert.deepEqual(harness.errors, []);
});

test("rejects foreign windows, child frames, foreign authorities, and non-normalized URLs", async () => {
  const harness = createHarness();
  const invoke = getHandler(harness, DESKTOP_IPC_CHANNELS.health.get);
  const invalidSenders = [
    sender({ senderId: 18 }),
    sender({ mainFrame: false }),
    sender({ url: "app://evil/index.html" }),
    sender({ url: "app://LOCAL/index.html" }),
    sender({ url: "app://local/a/../index.html" }),
  ];

  for (const invalidSender of invalidSenders) {
    await assert.rejects(() => invoke(invalidSender, {}), /Desktop operation rejected/u);
  }
  assert.equal(harness.errors.length, invalidSenders.length);
});

test("rejects missing, extra, and transport-shaped renderer arguments", async () => {
  let loginCalls = 0;
  const harness = createHarness(
    createService({
      auth: Object.freeze({
        login: async () => {
          loginCalls += 1;
          return SAFE_FAILURE;
        },
        refresh: async () => SAFE_FAILURE,
        pinChallenge: async () => SAFE_FAILURE,
        pinVerify: async () => SAFE_FAILURE,
        logout: async () => SAFE_FAILURE,
      }),
    }),
  );
  const invoke = getHandler(harness, DESKTOP_IPC_CHANNELS.auth.login);
  const valid = {
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "secret",
  };

  await assert.rejects(() => invoke(sender()), /Desktop operation rejected/u);
  await assert.rejects(() => invoke(sender(), valid, {}), /Desktop operation rejected/u);
  await assert.rejects(
    () =>
      invoke(sender(), {
        ...valid,
        url: "https://attacker.invalid",
        headers: { authorization: "Bearer attacker" },
      }),
    /Desktop operation rejected/u,
  );
  assert.equal(loginCalls, 0);
});

test("uses asynchronous registry validation for command and query inputs", async () => {
  let commandCalls = 0;
  const harness = createHarness(
    createService({
      command: Object.freeze({
        execute: async () => {
          commandCalls += 1;
          return SAFE_FAILURE;
        },
      }),
    }),
  );
  const invoke = getHandler(harness, DESKTOP_IPC_CHANNELS.command.execute);

  await assert.rejects(
    () => invoke(sender(), { name: "customer.upsert", body: { unknown: true } }),
    /Desktop operation rejected/u,
  );
  await assert.rejects(
    () => invoke(sender(), { name: "../../health", body: {} }),
    /Desktop operation rejected/u,
  );
  assert.equal(commandCalls, 0);
});

test("validates the service result before it crosses into the renderer", async () => {
  const harness = createHarness(
    createService({
      auth: Object.freeze({
        login: async () => ({
          ok: true,
          data: {
            access_token: "must.not.escape",
            headers: { authorization: "Bearer must.not.escape" },
          },
        }),
        refresh: async () => SAFE_FAILURE,
        pinChallenge: async () => SAFE_FAILURE,
        pinVerify: async () => SAFE_FAILURE,
        logout: async () => SAFE_FAILURE,
      }),
    }),
  );

  await assert.rejects(
    () =>
      getHandler(harness, DESKTOP_IPC_CHANNELS.auth.login)(sender(), {
        org_code: "local",
        store_code: "main",
        username: "admin",
        password: "secret",
      }),
    /Desktop operation rejected/u,
  );
  assert.equal(harness.errors.length, 1);
});
