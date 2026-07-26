import assert from "node:assert/strict";
import test from "node:test";

import type { LoginFormValues, SessionView, SwitchableStaff } from "../auth/types.js";
import { createDesktopPorts, type LaundryDesktopBridge } from "./desktop-ports.js";

type LoginInput = Parameters<LaundryDesktopBridge["auth"]["login"]>[0];
type PinChallengeInput = Parameters<LaundryDesktopBridge["auth"]["pinChallenge"]>[0];
type PinVerifyInput = Parameters<LaundryDesktopBridge["auth"]["pinVerify"]>[0];
type CommandInput = Parameters<LaundryDesktopBridge["command"]["execute"]>[0];
type QueryInput = Parameters<LaundryDesktopBridge["query"]["execute"]>[0];

const SESSION_VIEW: SessionView = Object.freeze({
  session: Object.freeze({
    session_id: "22222222-2222-4222-8222-222222222222",
    session_version: 1,
    org_id: "33333333-3333-4333-8333-333333333333",
    store_id: "44444444-4444-4444-8444-444444444444",
    staff_id: "11111111-1111-4111-8111-111111111103",
    device_id: "55555555-5555-4555-8555-555555555555",
    permission_version: 1,
  }),
  role: "admin",
  features: Object.freeze({ member_enabled: true }),
  display: Object.freeze({
    store_name: "本地门店",
    staff_name: "本地管理员",
    org_code: "local",
    store_code: "main",
  }),
});

const STAFF_DIRECTORY: readonly SwitchableStaff[] = Object.freeze([
  Object.freeze({
    staff_id: "11111111-1111-4111-8111-111111111101",
    display_name: "店员甲",
    role: "staff",
  }),
  Object.freeze({
    staff_id: "11111111-1111-4111-8111-111111111103",
    display_name: "本地管理员",
    role: "admin",
  }),
]);
const CONFIRM_REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function loginSuccess(
  sessionView: unknown = SESSION_VIEW,
  staffDirectory: unknown = STAFF_DIRECTORY,
): unknown {
  return {
    ok: true,
    data: {
      session_view: sessionView,
      staff_directory: staffDirectory,
    },
  };
}

function createPlannedAuthBridge(
  auth: Pick<LaundryDesktopBridge["auth"], "login" | "pinChallenge" | "pinVerify">,
): LaundryDesktopBridge["auth"] {
  return Object.freeze({
    login: auth.login,
    refresh: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
    pinChallenge: auth.pinChallenge,
    pinVerify: auth.pinVerify,
    logout: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
  });
}

test("desktop ports forward only named business operations and token-free views", async () => {
  const captured: unknown[] = [];
  const bridge: LaundryDesktopBridge = Object.freeze({
    auth: createPlannedAuthBridge({
      login: async (input: LoginInput) => {
        captured.push(input);
        return loginSuccess();
      },
      pinChallenge: async (input: PinChallengeInput) => {
        captured.push(input);
        return {
          ok: true,
          data: {
            challenge_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            purpose: input.purpose,
            expires_at: 1_800_000_000,
            max_attempts: 5,
          },
        };
      },
      pinVerify: async (input: PinVerifyInput) => {
        captured.push(input);
        return { ok: true, data: SESSION_VIEW };
      },
    }),
    command: Object.freeze({
      execute: async (input: CommandInput) => {
        captured.push(input);
        return { ok: true, data: { execution: "executed" } };
      },
    }),
    query: Object.freeze({
      execute: async (input: QueryInput) => {
        captured.push(input);
        return { ok: true, data: { execution: "executed" } };
      },
    }),
    health: Object.freeze({
      get: async () => ({ ok: true, data: { status: "ready" } }),
    }),
  });
  const ports = createDesktopPorts(bridge);

  const login = await ports.auth.login({
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "secret",
  });
  await ports.command.execute("order.receive", { customer_id: "customer-1" });
  await ports.command.execute(
    "order.receive",
    { ignored_on_confirm: true },
    {
      confirmRef: CONFIRM_REF,
    },
  );
  await ports.query.execute("order.list");

  assert.equal(login.ok, true);
  if (!login.ok) return;
  assert.doesNotMatch(
    JSON.stringify(login.data),
    /access_token|refresh_token|authorization|cookie|header/iu,
  );
  assert.deepEqual(ports.auth.listSwitchableStaff(), STAFF_DIRECTORY);
  assert.equal(Object.isFrozen(ports.auth.listSwitchableStaff()), true);
  assert.equal(Object.isFrozen(ports.auth.listSwitchableStaff()[0]), true);
  assert.deepEqual(captured, [
    {
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: "secret",
    },
    {
      name: "order.receive",
      body: { customer_id: "customer-1" },
    },
    {
      name: "order.receive",
      confirm_ref: CONFIRM_REF,
    },
    {
      name: "order.list",
      body: {},
    },
  ]);
  assert.equal("fetch" in bridge, false);
  assert.equal("invoke" in bridge, false);
});

test("desktop auth inputs fail closed before transport metadata can reach the bridge", async () => {
  const captured: unknown[] = [];
  const bridge: LaundryDesktopBridge = Object.freeze({
    auth: createPlannedAuthBridge({
      login: async (input: LoginInput) => {
        captured.push(input);
        return loginSuccess();
      },
      pinChallenge: async (input: PinChallengeInput) => {
        captured.push(input);
        return { ok: false, error: { code: "UNUSED", message: "unused" } };
      },
      pinVerify: async (input: PinVerifyInput) => {
        captured.push(input);
        return { ok: false, error: { code: "UNUSED", message: "unused" } };
      },
    }),
    command: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    query: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    health: Object.freeze({
      get: async () => ({ ok: true, data: { status: "ready" } }),
    }),
  });
  const unsafeLogin = {
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "secret",
    url: "https://attacker.invalid",
    method: "GET",
    headers: { authorization: "Bearer attacker" },
    cookie: "stolen=true",
  } as unknown as LoginFormValues;

  assert.deepEqual(await createDesktopPorts(bridge).auth.login(unsafeLogin), {
    ok: false,
    error: { code: "AUTH_CLIENT", message: "桌面登录参数格式错误" },
  });
  assert.deepEqual(captured, []);
});

test("desktop auth adapter rejects a step-up proof as a quick-switch session", async () => {
  const bridge: LaundryDesktopBridge = Object.freeze({
    auth: createPlannedAuthBridge({
      login: async () => loginSuccess(),
      pinChallenge: async () => ({
        ok: true,
        data: {
          challenge_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          purpose: "step_up",
          expires_at: 1_800_000_000,
          max_attempts: 5,
        },
      }),
      pinVerify: async () => ({
        ok: true,
        data: {
          step_up_proof_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          expires_at: 1_800_000_000,
        },
      }),
    }),
    command: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    query: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    health: Object.freeze({
      get: async () => ({ ok: true, data: { status: "ready" } }),
    }),
  });
  const result = await createDesktopPorts(bridge).auth.verifyPin({
    challenge_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pin: "1234",
  });

  assert.deepEqual(result, {
    ok: false,
    error: { code: "AUTH_CLIENT", message: "当前挑战为 step-up，请使用现场复核流程" },
  });
});

test("desktop auth adapter fails closed on credential-bearing or unknown session fields", async () => {
  const unsafeResults: readonly unknown[] = [
    loginSuccess({
      ...SESSION_VIEW,
      access_token: "must.not.escape",
    }),
    loginSuccess({
      ...SESSION_VIEW,
      display: {
        ...SESSION_VIEW.display,
        unexpected: "renderer-visible",
      },
    }),
    loginSuccess({
      ...SESSION_VIEW,
      features: {
        ...SESSION_VIEW.features,
        access_token: true,
      },
    }),
    {
      ok: true,
      data: {
        session_view: SESSION_VIEW,
        staff_directory: STAFF_DIRECTORY,
        refresh_token: "must.not.escape",
      },
    },
  ];

  for (const unsafeResult of unsafeResults) {
    const bridge: LaundryDesktopBridge = Object.freeze({
      auth: createPlannedAuthBridge({
        login: async () => unsafeResult,
        pinChallenge: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
        pinVerify: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
      }),
      command: Object.freeze({
        execute: async () => ({ ok: true, data: null }),
      }),
      query: Object.freeze({
        execute: async () => ({ ok: true, data: null }),
      }),
      health: Object.freeze({
        get: async () => ({ ok: true, data: { status: "ready" } }),
      }),
    });

    assert.deepEqual(
      await createDesktopPorts(bridge).auth.login({
        org_code: "local",
        store_code: "main",
        username: "admin",
        password: "secret",
      }),
      {
        ok: false,
        error: { code: "AUTH_CLIENT", message: "桌面登录响应格式错误" },
      },
    );
  }
});

test("desktop auth adapter freezes its directory copy and clears it after login failure", async () => {
  const sourceDirectory = [
    {
      staff_id: "11111111-1111-4111-8111-111111111101",
      display_name: "店员甲",
      role: "staff",
    },
  ];
  let nextLogin: unknown = loginSuccess(SESSION_VIEW, sourceDirectory);
  const bridge: LaundryDesktopBridge = Object.freeze({
    auth: createPlannedAuthBridge({
      login: async () => nextLogin,
      pinChallenge: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
      pinVerify: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
    }),
    command: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    query: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    health: Object.freeze({
      get: async () => ({ ok: true, data: { status: "ready" } }),
    }),
  });
  const ports = createDesktopPorts(bridge);
  const credentials = {
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "secret",
  };

  assert.equal((await ports.auth.login(credentials)).ok, true);
  const cached = ports.auth.listSwitchableStaff();
  assert.deepEqual(cached, sourceDirectory);
  assert.notStrictEqual(cached, sourceDirectory);
  assert.notStrictEqual(cached[0], sourceDirectory[0]);
  assert.equal(Object.isFrozen(cached), true);
  assert.equal(Object.isFrozen(cached[0]), true);

  nextLogin = {
    ok: false,
    error: { code: "AUTHENTICATION_FAILED", message: "用户名或密码错误" },
  };
  assert.equal((await ports.auth.login(credentials)).ok, false);
  assert.deepEqual(ports.auth.listSwitchableStaff(), []);
  assert.equal(Object.isFrozen(ports.auth.listSwitchableStaff()), true);
});

test("desktop auth adapter separates step-up proof from quick-switch session", async () => {
  const captured: unknown[] = [];
  let nextVerifyResult: unknown = {
    ok: true,
    data: {
      step_up_proof_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expires_at: 1_800_000_000,
    },
  };
  const bridge: LaundryDesktopBridge = Object.freeze({
    auth: createPlannedAuthBridge({
      login: async () => loginSuccess(),
      pinChallenge: async (input: PinChallengeInput) => {
        captured.push(input);
        return {
          ok: true,
          data: {
            challenge_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            purpose: input.purpose,
            expires_at: 1_800_000_000,
            max_attempts: 5,
          },
        };
      },
      pinVerify: async (input: PinVerifyInput) => {
        captured.push(input);
        return nextVerifyResult;
      },
    }),
    command: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    query: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    health: Object.freeze({
      get: async () => ({ ok: true, data: { status: "ready" } }),
    }),
  });
  const ports = createDesktopPorts(bridge);
  const challengeInput = {
    purpose: "step_up",
    pending_action_ref: "order.cancel:order-1",
    approver_staff_id: "11111111-1111-4111-8111-111111111103",
  } as const;
  const verifyInput = {
    challenge_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pin: "1234",
  } as const;

  assert.deepEqual(await ports.auth.createPinChallenge(challengeInput), {
    ok: true,
    data: {
      challenge_id: verifyInput.challenge_id,
      purpose: "step_up",
      expires_at: 1_800_000_000,
      max_attempts: 5,
    },
  });
  assert.deepEqual(await ports.auth.verifyStepUpPin(verifyInput), {
    ok: true,
    data: {
      step_up_proof_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expires_at: 1_800_000_000,
    },
  });

  nextVerifyResult = { ok: true, data: SESSION_VIEW };
  assert.deepEqual(await ports.auth.verifyStepUpPin(verifyInput), {
    ok: false,
    error: {
      code: "AUTH_CLIENT",
      message: "当前挑战为 quick-switch，请使用切换账号流程",
    },
  });
  assert.deepEqual(captured, [challengeInput, verifyInput, verifyInput]);
  assert.deepEqual(ports.auth.listSwitchableStaff(), []);
  assert.equal(Object.isFrozen(ports.auth.listSwitchableStaff()), true);
});

test("desktop command adapter preserves a strict business failure envelope", async () => {
  const bridge: LaundryDesktopBridge = Object.freeze({
    auth: createPlannedAuthBridge({
      login: async () => loginSuccess(),
      pinChallenge: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
      pinVerify: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
    }),
    command: Object.freeze({
      execute: async () => ({
        ok: false,
        error: {
          code: "STEP_UP_REQUIRED",
          detail: {
            kind: "step_up",
            confirm_ref: "confirm-1",
            message: "需要现场复核",
          },
          message: "操作需要确认",
        },
      }),
    }),
    query: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    health: Object.freeze({
      get: async () => ({ ok: true, data: { status: "ready" } }),
    }),
  });

  assert.deepEqual(await createDesktopPorts(bridge).command.execute("order.cancel"), {
    ok: false,
    error: {
      code: "STEP_UP_REQUIRED",
      detail: {
        kind: "step_up",
        confirm_ref: "confirm-1",
        message: "需要现场复核",
      },
      message: "操作需要确认",
    },
  });
});

test("desktop business values preserve contract fields named method", async () => {
  const captured: CommandInput[] = [];
  const bridge: LaundryDesktopBridge = Object.freeze({
    auth: createPlannedAuthBridge({
      login: async () => loginSuccess(),
      pinChallenge: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
      pinVerify: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
    }),
    command: Object.freeze({
      execute: async (input: CommandInput) => {
        captured.push(input);
        const method =
          "body" in input && typeof input.body === "object" && input.body !== null
            ? Reflect.get(input.body, "method")
            : undefined;
        return { ok: true, data: { method } };
      },
    }),
    query: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    health: Object.freeze({
      get: async () => ({ ok: true, data: { status: "ready" } }),
    }),
  });
  const body = Object.freeze({
    order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    amount_cents: 1_200,
    method: "cash",
  });

  const result = await createDesktopPorts(bridge).command.execute("payment.collect", body);

  assert.deepEqual(captured, [{ name: "payment.collect", body }]);
  assert.deepEqual(result, { ok: true, data: { method: "cash" } });
});

test("desktop command and query adapters reject malformed names and transport metadata", async () => {
  let commandCalls = 0;
  let queryCalls = 0;
  const bridge: LaundryDesktopBridge = Object.freeze({
    auth: createPlannedAuthBridge({
      login: async () => loginSuccess(),
      pinChallenge: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
      pinVerify: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
    }),
    command: Object.freeze({
      execute: async () => {
        commandCalls += 1;
        return { ok: true, data: null };
      },
    }),
    query: Object.freeze({
      execute: async () => {
        queryCalls += 1;
        return { ok: true, data: null };
      },
    }),
    health: Object.freeze({
      get: async () => ({ ok: true, data: { status: "ready" } }),
    }),
  });
  const ports = createDesktopPorts(bridge);
  const malformedNames: readonly unknown[] = [
    123,
    "",
    "order",
    "Order.receive",
    "order/receive",
    "order.receive?url=https://attacker.invalid",
  ];

  for (const name of malformedNames) {
    assert.equal((await ports.command.execute(name as string)).ok, false);
    assert.equal((await ports.query.execute(name as string)).ok, false);
  }
  assert.equal(
    (
      await ports.command.execute("order.receive", {
        lines: [{ service_code: "wash", headers: { authorization: "Bearer stolen" } }],
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await ports.query.execute("order.list", {
        filters: { access_token: "must.not.reach.main" },
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await ports.command.execute(
        "order.receive",
        {},
        {
          confirmRef: {
            headers: { authorization: "Bearer stolen" },
          } as unknown as string,
        },
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await ports.command.execute(
        "order.receive",
        {},
        {
          confirmRef: "not-a-confirm-reference",
        },
      )
    ).ok,
    false,
  );
  assert.equal(commandCalls, 0);
  assert.equal(queryCalls, 0);
});

test("desktop adapters reject credential-bearing successful business data", async () => {
  const bridge: LaundryDesktopBridge = Object.freeze({
    auth: createPlannedAuthBridge({
      login: async () => loginSuccess(),
      pinChallenge: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
      pinVerify: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
    }),
    command: Object.freeze({
      execute: async () => ({
        ok: true,
        data: { order: { access_token: "command-secret" } },
      }),
    }),
    query: Object.freeze({
      execute: async () => ({
        ok: true,
        data: { rows: [{ headers: { authorization: "query-secret" } }] },
      }),
    }),
    health: Object.freeze({
      get: async () => ({ ok: true, data: { status: "ready" } }),
    }),
  });
  const ports = createDesktopPorts(bridge);

  const command = await ports.command.execute("order.receive", { paid_cents: 0 });
  const query = await ports.query.execute("order.list", { limit: 20 });

  assert.equal(command.ok, false);
  assert.equal(query.ok, false);
  assert.doesNotMatch(JSON.stringify([command, query]), /command-secret|query-secret/u);
});

test("desktop health adapter never renders a main-process failure message", async () => {
  const bridge: LaundryDesktopBridge = Object.freeze({
    auth: createPlannedAuthBridge({
      login: async () => loginSuccess(),
      pinChallenge: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
      pinVerify: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
    }),
    command: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    query: Object.freeze({
      execute: async () => ({ ok: true, data: null }),
    }),
    health: Object.freeze({
      get: async () => ({
        ok: false,
        error: {
          code: "PG_CONNECTION_FAILED",
          message: "postgres://admin:super-secret@127.0.0.1/laundry",
        },
      }),
    }),
  });

  const health = await createDesktopPorts(bridge).health.get();

  assert.deepEqual(health, {
    ok: false,
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "桌面本地服务不可用，请确认服务已启动后重试",
    },
  });
  assert.doesNotMatch(JSON.stringify(health), /postgres|super-secret|PG_CONNECTION_FAILED/iu);
});
