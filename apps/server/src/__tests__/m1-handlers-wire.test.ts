/**
 * Integration: M1 identity + platform handlers on C1 bus with C5 policy hooks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { M1_FIRST_WAVE_COMMAND_NAMES } from "@laundry/contracts";

import type { ActorContext } from "../bus/types.js";
import { executeCommand } from "../bus/executor.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import {
  createDefaultChainHooks,
  createRegisteredM1Bus,
  registerM1Handlers,
  requiredPermissionsFromInvariants,
} from "../handlers/index.js";
import { createAccessTokenSigner } from "../identity/crypto-util.js";
import { createLoginService } from "../identity/login.js";
import { createMemoryIdentityStore } from "../identity/memory-store.js";
import { createTestPasswordPort } from "../identity/password.js";
import { createPinService } from "../identity/pin.js";
import { createSessionService } from "../identity/session.js";
import type { SessionRecord, StaffRecord } from "../identity/types.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import { createM1CommandRegistry } from "../bus/registry.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});

const ACTOR: ActorContext = Object.freeze({
  staffId: STAFF_ID,
  deviceId: DEVICE_ID,
  via: "ui" as const,
  permissions: Object.freeze(["settings_admin"]),
});

const FIXED_NOW = () => new Date("2026-07-21T12:00:00.000Z");
const FIXED_ID = () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

async function buildIdentityDeps() {
  const store = createMemoryIdentityStore();
  const passwordPort = createTestPasswordPort();
  const passwordHash = await passwordPort.hashPassword("correct-horse");
  const pinHash = await passwordPort.hashPassword("1234");

  store.seedOrgStore({
    org_id: ORG_ID,
    org_code: "hongfa",
    store_id: STORE_ID,
    store_code: "main",
  });

  const staff: StaffRecord = Object.freeze({
    staff_id: STAFF_ID,
    org_id: ORG_ID,
    username: "counter1",
    password_hash: passwordHash,
    pin_hash: pinHash,
    display_name: "Counter One",
    is_active: true,
    permission_version: 1,
  });
  store.seedStaff(staff);

  const clock = {
    nowEpochSeconds: () => 1_700_000_000,
  };
  const sessionDeps = {
    sessions: store.sessions,
    refresh: store.refresh,
    clock,
    accessTokenSigner: createAccessTokenSigner("test-access-secret"),
  };
  const login = {
    staff: store.staff,
    orgStore: store.orgStore,
    passwordPort,
    sessions: sessionDeps,
  };
  const pin = {
    challenges: store.pinChallenges,
    lockouts: store.pinLockouts,
    staff: store.staff,
    pinPort: passwordPort,
    clock,
    sessions: sessionDeps,
  };

  let bindingSession: SessionRecord | null = null;
  let bindingRefresh: string | null = null;

  return {
    store,
    loginService: createLoginService(login),
    sessions: createSessionService(sessionDeps),
    pinService: createPinService(pin),
    identityDeps: {
      login,
      sessions: sessionDeps,
      pin,
      pinChallenges: store.pinChallenges,
      clock,
      resolveBinding: async () =>
        Object.freeze({
          session: bindingSession,
          refreshSecret: bindingRefresh,
        }),
    },
    setBinding: (session: SessionRecord | null, refresh: string | null) => {
      bindingSession = session;
      bindingRefresh = refresh;
    },
  };
}

function buildPlatformDeps() {
  return Object.freeze({
    settings: createMemorySettingsStore({
      "store.name": JSON.stringify("Demo Laundry"),
    }),
    features: createMemoryFeaturesStore({
      [STORE_ID]: { fulfillment: true, ai: false },
    }),
    audit: createMemoryAuditQueryStore(),
  });
}

test("M1_FIRST_WAVE_COMMAND_NAMES are all registerable as commands", () => {
  const registry = createM1CommandRegistry();
  for (const name of M1_FIRST_WAVE_COMMAND_NAMES) {
    assert.ok(registry.get(name) !== undefined, `missing definition ${name}`);
  }
  assert.ok(M1_FIRST_WAVE_COMMAND_NAMES.includes("identity.login"));
  assert.ok(M1_FIRST_WAVE_COMMAND_NAMES.includes("platform.settings.set"));
});

test("requiredPermissionsFromInvariants extracts rbac.* codes", () => {
  assert.deepEqual(
    requiredPermissionsFromInvariants(["platform.settings_writable", "rbac.settings_admin"]),
    ["settings_admin"],
  );
  assert.deepEqual(requiredPermissionsFromInvariants(["identity.credentials_valid"]), []);
});

test("platform.settings.set via registerM1Handlers + default C5 policy hooks", async () => {
  const platform = buildPlatformDeps();
  const { registry, chainHooks, registered } = createRegisteredM1Bus({ platform });
  assert.ok(registered.includes("platform.settings.set"));

  const client = new FakeSqlClient();
  // R5: direct execution is blocked; pending card issued.
  const gated = await executeCommand(
    client,
    TENANT,
    "platform.settings.set",
    {
      entries: [{ key: "store.name", value_json: JSON.stringify("Hongfa Front Desk") }],
    },
    {
      actor: ACTOR,
      registry,
      chainHooks,
      now: FIXED_NOW,
      newId: FIXED_ID,
    },
  );
  assert.equal(gated.ok, false);
  if (gated.ok) assert.fail("expected step-up");
  assert.equal(gated.error.code, "POLICY_STEP_UP_REQUIRED");
  const detail = "detail" in gated.error ? gated.error.detail : undefined;
  assert.equal(detail?.kind, "confirmation");
  if (detail?.kind !== "confirmation") assert.fail("confirm_ref required");

  const approver: ActorContext = Object.freeze({
    staffId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    deviceId: DEVICE_ID,
    via: "ui" as const,
    permissions: Object.freeze(["settings_admin"]),
  });
  const result = await executeCommand(
    client,
    { ...TENANT, staffId: approver.staffId },
    "platform.settings.set",
    {},
    {
      actor: approver,
      registry,
      chainHooks,
      confirmRef: detail.confirm_ref,
      now: FIXED_NOW,
      newId: FIXED_ID,
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.equal(result.data.execution, "executed");
    assert.deepEqual(result.data.result, { updated: 1 });
  }
  const values = await platform.settings.getMany(["store.name"]);
  assert.equal(values["store.name"], JSON.stringify("Hongfa Front Desk"));
});

test("platform.settings.set RBAC denies without settings_admin", async () => {
  const platform = buildPlatformDeps();
  const { registry, chainHooks } = createRegisteredM1Bus({ platform });
  const actorNoPerm: ActorContext = Object.freeze({
    staffId: STAFF_ID,
    deviceId: DEVICE_ID,
    via: "ui" as const,
    permissions: Object.freeze([] as string[]),
  });

  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    {
      entries: [{ key: "store.name", value_json: JSON.stringify("X") }],
    },
    {
      actor: actorNoPerm,
      registry,
      chainHooks,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, "PERMISSION_DENIED");
  }
});

test("identity.login via bus returns A2 access session shape", async () => {
  const built = await buildIdentityDeps();
  const platform = buildPlatformDeps();
  const registry = createM1CommandRegistry();
  const registered = registerM1Handlers(registry, {
    identity: built.identityDeps,
    platform,
  });
  assert.ok(registered.includes("identity.login"));
  assert.ok(registered.includes("platform.settings.set"));

  const chainHooks = createDefaultChainHooks();
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "identity.login",
    {
      org_code: "hongfa",
      store_code: "main",
      username: "counter1",
      password: "correct-horse",
      device_id: DEVICE_ID,
    },
    {
      actor: ACTOR,
      registry,
      chainHooks,
      now: FIXED_NOW,
      newId: FIXED_ID,
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.execution, "executed");
    const payload = result.data.result as {
      access_token: string;
      token_type: string;
      expires_in: number;
      storage: string;
      session: { staff_id: string; org_id: string; store_id: string };
    };
    assert.equal(payload.token_type, "Bearer");
    assert.equal(payload.storage, "memory_only");
    assert.equal(payload.session.staff_id, STAFF_ID);
    assert.equal(payload.session.org_id, ORG_ID);
    assert.equal(payload.session.store_id, STORE_ID);
    assert.match(payload.access_token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    // A2 shape: no raw password / no unexpected secret cookie fields required.
    assert.equal("password" in payload, false);
  }
});

test("identity.login fails with AUTHENTICATION_FAILED on bad password", async () => {
  const built = await buildIdentityDeps();
  const { registry, chainHooks } = createRegisteredM1Bus({ identity: built.identityDeps });

  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "identity.login",
    {
      org_code: "hongfa",
      store_code: "main",
      username: "counter1",
      password: "wrong-password",
      device_id: DEVICE_ID,
    },
    {
      actor: ACTOR,
      registry,
      chainHooks,
    },
  );

  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, "AUTHENTICATION_FAILED");
  }
});

test("identity.logout via bus after login binding", async () => {
  const built = await buildIdentityDeps();
  const { registry, chainHooks } = createRegisteredM1Bus({ identity: built.identityDeps });

  const loginResult = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "identity.login",
    {
      org_code: "hongfa",
      store_code: "main",
      username: "counter1",
      password: "correct-horse",
      device_id: DEVICE_ID,
    },
    { actor: ACTOR, registry, chainHooks, now: FIXED_NOW, newId: FIXED_ID },
  );
  assert.equal(loginResult.ok, true);
  if (!loginResult.ok) {
    assert.fail("expected login success");
  }

  const sessionView = (loginResult.data.result as { session: { session_id: string } }).session;
  const stored = built.store.listSessions().find((s) => s.session_id === sessionView.session_id);
  assert.ok(stored);
  built.setBinding(stored, null);

  const logout = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "identity.logout",
    {},
    { actor: ACTOR, registry, chainHooks, now: FIXED_NOW, newId: FIXED_ID },
  );
  assert.equal(logout.ok, true);
  if (logout.ok) {
    assert.deepEqual(logout.data.result, { logged_out: true });
  }
  const after = await built.store.sessions.get(stored.session_id);
  assert.equal(after?.status, "revoked");
});

test("default C5 policy denies R5 for via=ai", async () => {
  const platform = buildPlatformDeps();
  const { registry, chainHooks } = createRegisteredM1Bus({ platform });
  const aiActor: ActorContext = Object.freeze({
    staffId: STAFF_ID,
    deviceId: DEVICE_ID,
    via: "ai" as const,
    permissions: Object.freeze(["settings_admin"]),
    riskCap: "R2" as const,
  });

  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "platform.settings.set",
    {
      entries: [{ key: "store.name", value_json: JSON.stringify("Nope") }],
    },
    { actor: aiActor, registry, chainHooks },
  );

  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.error.code, "POLICY_DENIED");
  }
});
