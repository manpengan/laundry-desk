import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  createCommandError,
  type DesktopSessionView,
  type ReceiveRecoveryDraft,
} from "@laundry/contracts";
import { createDesktopJsonRequester } from "./command-request.js";
import { ReceiveRecoveryJournal, type RecoveryFile } from "./receive-recovery-journal.js";
import { createReceiveRecoveryOperation } from "./receive-recovery-operation.js";
import type { AuthState } from "./http-transport-support.js";
import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";
import type { DesktopHttpRequest } from "./request-builder.js";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
] as const;
const session: DesktopSessionView = {
  session: {
    session_id: ids[0],
    session_version: 1,
    org_id: ids[1],
    store_id: ids[2],
    staff_id: ids[3],
    device_id: ids[4],
    permission_version: 1,
  },
  role: "staff",
  features: {},
  display: { store_name: "合成测试", staff_name: "测试员工", org_code: "test", store_code: "test" },
};
const body = {
  customer_phone: "13800000999",
  lines: [{ service_code: "wash", category_code: "coat", qty: 1 }],
  initial_payment: { amount_cents: 1000, method: "cash" },
};
const draft: ReceiveRecoveryDraft = {
  operationId: ids[5],
  phone: "13800000999",
  name: "恢复合成客户",
  paymentCents: "1000",
  paymentMethod: "cash",
  pricing: { discount_cents: "0", urgent: false, freight: false },
  note: "",
  draftId: null,
  dirty: true,
  lines: [
    {
      key: "a",
      service_code: "wash",
      category_code: "coat",
      unit_price_cents: 1000,
      qty: "1",
      garments: [],
    },
  ],
};
const success = {
  ok: true as const,
  data: { execution: "executed" as const, result: { order_id: ids[5] } },
};
const storage: SafeStorageSurface = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`protected:${text}`),
  decryptString: (bytes) => {
    const text = bytes.toString();
    if (!text.startsWith("protected:")) throw new Error("OS storage unavailable");
    return text.slice("protected:".length);
  },
};
function memoryFiles() {
  const data = new Map<string, unknown>();
  let rejected: ((path: string, value: unknown) => boolean) | null = null;
  const factory = (path: string): RecoveryFile => ({
    read: () => structuredClone(data.get(path) ?? null),
    write: (value) => {
      if (rejected?.(path, value)) throw new Error("disk write failed");
      data.set(path, structuredClone(value));
    },
  });
  return {
    data,
    factory,
    fail: (predicate: typeof rejected) => {
      rejected = predicate;
    },
  };
}
const path = "/v1/commands/order.receive";
const expected = { session_id: session.session.session_id, session_version: 1 };

test("a failed prepare write makes zero HTTP calls and keeps the draft", async () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  journal.save(session, draft);
  files.fail((file) => basename(dirname(file)) === "operations");
  let calls = 0;
  const send = createDesktopJsonRequester(
    async () => {
      calls++;
      throw new Error("must not send");
    },
    () => session,
    undefined,
    journal,
  );
  assert.equal(await send("POST", path, { body, operationId: draft.operationId }), null);
  assert.equal(calls, 0);
  assert.deepEqual(journal.load(session).draft, draft);
});

test("lost commit response survives process rebuild and new session with the original key/body", async () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  journal.save(session, draft);
  const requests: DesktopHttpRequest[] = [];
  const committed = new Set<string>();
  const request = async (input: DesktopHttpRequest) => {
    requests.push(input);
    committed.add(input.headers["Idempotency-Key"]!);
    if (requests.length === 1) throw new Error("committed but connection closed");
    return { statusCode: 200, bodyText: JSON.stringify(success) };
  };
  await createDesktopJsonRequester(
    request,
    () => session,
    undefined,
    journal,
  )("POST", path, { body, operationId: draft.operationId });
  const rebuilt = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  const relogged = {
    ...session,
    session: { ...session.session, session_id: ids[5], session_version: 9 },
  };
  assert.deepEqual(rebuilt.load(relogged).pending_body, body);
  await createDesktopJsonRequester(
    request,
    () => relogged,
    undefined,
    rebuilt,
  )("POST", path, { body, operationId: draft.operationId });
  assert.equal(committed.size, 1);
  assert.equal(requests[0]?.body, requests[1]?.body);
  assert.deepEqual(rebuilt.load(relogged).receipt, success);
});

test("success survives a crash before IPC delivery and completed identities are never recycled", async () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  journal.save(session, draft);
  const sent: string[] = [];
  const request = async (input: DesktopHttpRequest) => {
    sent.push(input.headers["Idempotency-Key"]!);
    return { statusCode: 200, bodyText: JSON.stringify(success) };
  };
  const run = (j: ReceiveRecoveryJournal, id: string) =>
    createDesktopJsonRequester(
      request,
      () => session,
      undefined,
      j,
    )("POST", path, { body, operationId: id });
  await run(journal, draft.operationId); // The renderer never sees this receipt.
  const restarted = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  assert.deepEqual(restarted.load(session).receipt, success);
  const old = restarted.prepare(session, draft.operationId, JSON.stringify(body));
  restarted.save(session, { ...draft, operationId: ids[0] });
  await run(restarted, ids[0]);
  assert.notEqual(sent[0], sent[1]);
  assert.equal(restarted.prepare(session, draft.operationId, JSON.stringify(body)).key, old.key);
  assert.throws(
    () =>
      restarted.prepare(session, draft.operationId, JSON.stringify({ ...body, note: "different" })),
    /不能更换/u,
  );
});

test("receipt write failure leaves the prepared operation replayable with no new key", async () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  journal.save(session, draft);
  const sent: string[] = [];
  const request = async (input: DesktopHttpRequest) => {
    sent.push(input.headers["Idempotency-Key"]!);
    return { statusCode: 200, bodyText: JSON.stringify(success) };
  };
  files.fail(
    (file, value) =>
      basename(dirname(file)) === "operations" && Reflect.get(value as object, "response") !== null,
  );
  const send = createDesktopJsonRequester(request, () => session, undefined, journal);
  assert.equal(await send("POST", path, { body, operationId: draft.operationId }), null);
  assert.equal(journal.load(session).receipt, null);
  assert.throws(() => journal.save(session, { ...draft, operationId: ids[0] }), /先确认/u);
  files.fail(null);
  await send("POST", path, { body, operationId: draft.operationId });
  assert.equal(sent[0], sent[1]);
});

test("first 401 then retry with lost response cannot restore the earlier rejection or allow a new identity", async () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  journal.save(session, draft);
  const keys: string[] = [];
  const send = createDesktopJsonRequester(
    async (input) => {
      keys.push(input.headers["Idempotency-Key"]!);
      if (keys.length === 1)
        return {
          statusCode: 401,
          bodyText: JSON.stringify({
            ok: false,
            error: createCommandError("AUTHENTICATION_FAILED"),
          }),
        };
      throw new Error("committed after refresh but response lost");
    },
    () => session,
    undefined,
    journal,
  );
  await send("POST", path, { body, operationId: draft.operationId });
  assert.equal(journal.load(session).receipt?.ok, false);
  await send("POST", path, { body, operationId: draft.operationId });
  const rebuilt = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  assert.equal(rebuilt.load(session).receipt, null);
  assert.equal(keys[0], keys[1]);
  assert.throws(() => rebuilt.save(session, { ...draft, operationId: ids[0] }), /先确认/u);
});

test("main-owned employee, store, organization and device scopes isolate recovery", () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  journal.save(session, draft);
  for (const key of ["staff_id", "store_id", "org_id", "device_id"] as const) {
    const other = { ...session, session: { ...session.session, [key]: ids[5] } };
    assert.equal(journal.load(other).draft, null);
  }
});

test("a later authorization rejection cannot erase an earlier unknown outcome", async () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  journal.save(session, draft);
  let calls = 0;
  const send = createDesktopJsonRequester(
    async () => {
      if (++calls === 1) throw new Error("original response lost");
      return {
        statusCode: 403,
        bodyText: JSON.stringify({ ok: false, error: createCommandError("PERMISSION_DENIED") }),
      };
    },
    () => session,
    undefined,
    journal,
  );
  await send("POST", path, { body, operationId: draft.operationId });
  await send("POST", path, { body, operationId: draft.operationId });
  assert.equal(journal.load(session).receipt, null);
  assert.throws(() => journal.save(session, { ...draft, operationId: ids[0] }), /先确认/u);
});

test("a missing prepared file cannot silently turn a submitted order back into an editable draft", () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  journal.save(session, draft);
  journal.prepare(session, draft.operationId, JSON.stringify(body));
  const path = [...files.data.keys()].find((file) => basename(dirname(file)) === "operations");
  assert.ok(path, "prepared operation must exist before simulating its removal");
  assert.equal(files.data.delete(path), true);
  assert.throws(() => journal.load(session), /Missing/u);
  assert.throws(() => journal.save(session, draft), /Missing/u);
});

test("converting a saved server draft may clear its draft id after the durable successful receipt", () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  const held = { ...draft, draftId: ids[0] };
  journal.save(session, held);
  journal.prepare(session, draft.operationId, JSON.stringify(body));
  assert.throws(() => journal.save(session, { ...held, phone: "13800000123" }), /不能更换/u);
  journal.confirm(session, draft.operationId, JSON.stringify(body), {
    statusCode: 200,
    payload: success,
  });
  journal.save(session, { ...held, draftId: null, dirty: false });
  assert.deepEqual(journal.load(session).receipt, success);
});

test("stale session callbacks and unsupported roles cannot access recovery", async () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  let state: AuthState | null = {
    accessToken: "test",
    csrfToken: "test",
    expiresAtMs: 1000,
    sessionView: session,
  };
  let submissions = 0;
  const service = createReceiveRecoveryOperation(
    journal,
    () => state,
    async () => {
      submissions++;
      return success;
    },
  );
  state = {
    ...state,
    sessionView: {
      ...session,
      session: { ...session.session, staff_id: ids[5], session_version: 2 },
    },
  };
  const rejected = await service.execute({ operation: "save", expected_session: expected, draft });
  assert.equal(rejected.ok, false);
  assert.equal(journal.load(state.sessionView).draft, null);
  // An access token that lapsed while the counter sat idle is the same employee: the local
  // record stays readable, and the submit path refreshes the token itself.
  state = { ...state, sessionView: session, expiresAtMs: 0 };
  assert.equal((await service.execute({ operation: "load", expected_session: expected })).ok, true);
  state = {
    ...state,
    expiresAtMs: 1000,
    sessionView: { ...session, role: "owner" } as unknown as DesktopSessionView,
  };
  assert.equal(
    (await service.execute({ operation: "load", expected_session: expected })).ok,
    false,
  );
  state = null;
  assert.equal(
    (await service.execute({ operation: "load", expected_session: expected })).ok,
    false,
  );
  assert.equal(submissions, 0);
});

test("late successful responses are persisted only under the original employee", async () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory);
  journal.save(session, draft);
  let current = session;
  const other = { ...session, session: { ...session.session, staff_id: ids[5] } };
  const send = createDesktopJsonRequester(
    async () => {
      current = other;
      return { statusCode: 200, bodyText: JSON.stringify(success) };
    },
    () => current,
    undefined,
    journal,
  );
  await send("POST", path, { body, operationId: draft.operationId });
  assert.deepEqual(journal.load(session).receipt, success);
  assert.equal(journal.load(other).draft, null);
});

test("encrypted files contain no customer plaintext and corruption/OS decryption failure blocks loading", (t) => {
  const temporaryDirectory = tmpdir();
  const canonicalTemporaryDirectory = realpathSync.native(temporaryDirectory);
  if (process.platform === "win32") {
    t.diagnostic(
      `windows_temp_canonicalized=${canonicalTemporaryDirectory.toLowerCase() !== temporaryDirectory.toLowerCase()}`,
    );
    t.diagnostic(
      `windows_temp_js_equals_native=${realpathSync(temporaryDirectory).toLowerCase() === canonicalTemporaryDirectory.toLowerCase()}`,
    );
  }
  const root = mkdtempSync(join(canonicalTemporaryDirectory, "receive-recovery-"));
  try {
    const journal = new ReceiveRecoveryJournal(root, storage);
    journal.save(session, draft);
    const scope = readdirSync(root)[0]!;
    const file = join(root, scope, "workspace", "offline-read-cache.json");
    const bytes = readFileSync(file, "utf8");
    assert.equal(bytes.includes(draft.phone), false);
    assert.equal(bytes.includes(draft.name), false);
    const unavailable = {
      ...storage,
      decryptString: () => {
        throw new Error("wrong OS user");
      },
    };
    assert.throws(() => new ReceiveRecoveryJournal(root, unavailable).load(session));
    writeFileSync(file, "corrupted");
    assert.throws(() => journal.load(session));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unavailable OS encryption blocks prepare before any request", async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "receive-recovery-"));
  try {
    const unavailable = { ...storage, isEncryptionAvailable: () => false };
    const journal = new ReceiveRecoveryJournal(root, unavailable);
    let calls = 0;
    const send = createDesktopJsonRequester(
      async () => {
        calls++;
        return {
          statusCode: 503,
          bodyText: JSON.stringify({
            ok: false,
            error: createCommandError("RESOURCE_UNAVAILABLE"),
          }),
        };
      },
      () => session,
      undefined,
      journal,
    );
    assert.equal(await send("POST", path, { body, operationId: draft.operationId }), null);
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const sentKey = "77777777-7777-4777-8777-777777777777";
const submitInput = {
  operation: "submit",
  expected_session: expected,
  operation_id: draft.operationId,
  body,
};
const idle = (): AuthState => ({
  accessToken: "test",
  csrfToken: "test",
  expiresAtMs: 0,
  sessionView: session,
});
const queuedReceipt = {
  ok: true as const,
  data: {
    execution: "executed" as const,
    result: { ...body, offline_queued: true, queue_id: ids[0] },
  },
};
const lostAnswer = { ok: false as const, error: createCommandError("RESOURCE_UNAVAILABLE") };

test("a receive sent before an outage is queued offline under the key it was sent with", async () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory, () => sentKey);
  journal.save(session, draft);
  const service = createReceiveRecoveryOperation(journal, idle, async (sent, id) => {
    journal.prepare(session, id, JSON.stringify(sent)); // the request went out...
    return lostAnswer; // ...and its answer never came back
  });
  assert.equal((await service.execute(submitInput)).ok, false);
  const queued: [unknown, string][] = [];
  const handed = await service.queueOffline(submitInput, async (queuedBody, key) => {
    queued.push([queuedBody, key]);
    return queuedReceipt;
  });
  assert.deepEqual(queued, [[body, sentKey]]);
  assert.deepEqual(handed?.ok === true ? handed.data.receipt : handed, queuedReceipt);
  // The receive the queue owns no longer holds up the next order.
  journal.save(session, { ...draft, operationId: ids[1] });
});

test("a receive the outage stopped before sending gets its first key in the queue", async () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory, () => sentKey);
  journal.save(session, draft);
  const service = createReceiveRecoveryOperation(journal, idle, async () => lostAnswer);
  assert.equal((await service.execute(submitInput)).ok, false);
  assert.equal(journal.hasOperation(session, draft.operationId), false);
  const keys: string[] = [];
  const handed = await service.queueOffline(submitInput, async (_body, key) => {
    keys.push(key);
    return queuedReceipt;
  });
  assert.deepEqual(keys, [sentKey]);
  assert.equal(handed?.ok, true);
  assert.equal(journal.unconfirmed(session, draft.operationId), null);
});

test("an answered receive is never queued, and a refused queue keeps the original key", async () => {
  const files = memoryFiles();
  const journal = new ReceiveRecoveryJournal("/recovery", storage, files.factory, () => sentKey);
  journal.save(session, draft);
  let refused = 0;
  const refuse = async () => {
    refused++;
    return lostAnswer;
  };
  const answered = createReceiveRecoveryOperation(journal, idle, async (sent, id) => {
    journal.prepare(session, id, JSON.stringify(sent));
    journal.confirm(session, id, JSON.stringify(sent), { statusCode: 200, payload: success });
    return success;
  });
  assert.equal((await answered.execute(submitInput)).ok, true);
  assert.equal(await answered.queueOffline(submitInput, refuse), null);
  assert.equal(refused, 0);

  const other = new ReceiveRecoveryJournal(
    "/recovery",
    storage,
    memoryFiles().factory,
    () => sentKey,
  );
  other.save(session, draft);
  const lost = createReceiveRecoveryOperation(other, idle, async (sent, id) => {
    other.prepare(session, id, JSON.stringify(sent));
    return lostAnswer;
  });
  await lost.execute(submitInput);
  assert.equal(await lost.queueOffline(submitInput, refuse), null);
  assert.equal(refused, 1);
  assert.deepEqual(other.unconfirmed(session, draft.operationId), {
    key: sentKey,
    body: JSON.stringify(body),
  });
});
