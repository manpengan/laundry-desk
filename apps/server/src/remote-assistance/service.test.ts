import assert from "node:assert/strict";
import test from "node:test";
import { createAssistanceService } from "./service.js";
import { actorFixture, deferred, proofFixture, repositoryFixture } from "./test-fixture.js";
const untilAbort = async (signal: AbortSignal) => {
  if (signal.aborted) throw new Error("aborted");
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
};
test("no configuration or a database row alone can activate a remote worker", async () => {
  const f = proofFixture(),
    db = repositoryFixture(),
    auth = actorFixture();
  let polls = 0;
  const service = createAssistanceService({
    repository: db.repository,
    trust: null,
    transport: null,
    reportFailure: () => assert.fail("unexpected"),
    now: () => f.now,
  });
  assert.equal((await service.status(auth)).state, "unconfigured");
  await assert.rejects(service.authorize(auth), /UNCONFIGURED/);
  await db.seed({ id: f.claims.session_id, auth, approvedAt: f.now, expiresAt: f.now + 3600000 });
  const restarted = createAssistanceService({
    repository: db.repository,
    trust: f.trust,
    transport: {
      poll: async () => {
        polls++;
        return null;
      },
      deliver: async () => {},
    },
    reportFailure: () => {},
    now: () => f.now,
  });
  assert.equal((await restarted.status(auth)).state, "interrupted");
  assert.equal(polls, 0);
  await restarted.close();
  await service.close();
});
test("signed synthetic command produces only aggregate output and command/delivery receipts", async () => {
  const f = proofFixture(),
    db = repositoryFixture(),
    auth = actorFixture(),
    done = deferred();
  const service = createAssistanceService({
    repository: db.repository,
    trust: f.trust,
    now: () => f.now,
    wait: untilAbort,
    reportFailure: () => assert.fail("unexpected"),
    transport: {
      poll: async (session_id, nonce) => f.signed({ ...f.claims, session_id, nonce }),
      deliver: async (_session, _request, result) => {
        assert.deepEqual(result, { database: "ready", mode: "windows_local" });
        done.resolve();
      },
    },
  });
  try {
    const status = await service.authorize(auth);
    await done.promise;
    assert.equal(status.state, "active");
    assert.ok(db.calls.includes("runtime.health"));
  } finally {
    await service.close();
  }
  assert.ok(db.calls.includes("delivered"));
});
test("revocation aborts an in-flight poll and prevents executing its late command", async () => {
  const f = proofFixture(),
    db = repositoryFixture(),
    auth = actorFixture(),
    entered = deferred();
  let delivered = 0;
  const service = createAssistanceService({
    repository: db.repository,
    trust: f.trust,
    now: () => f.now,
    reportFailure: () => {},
    transport: {
      poll: async (session_id, nonce, signal) => {
        entered.resolve();
        await untilAbort(signal);
        return f.signed({ ...f.claims, session_id, nonce });
      },
      deliver: async () => {
        delivered++;
      },
    },
  });
  const active = await service.authorize(auth);
  await entered.promise;
  assert.ok(active.session_id);
  assert.equal((await service.revoke(auth, active.session_id)).state, "revoked");
  assert.equal(delivered, 0);
  assert.equal(db.calls.includes("runtime.health"), false);
  await service.close();
});
test("one hour expires by monotonic time even when the wall clock goes backwards", async () => {
  const f = proofFixture(),
    db = repositoryFixture(),
    auth = actorFixture(),
    entered = deferred(),
    release = deferred();
  let time = 0,
    wall = f.now;
  const service = createAssistanceService({
    repository: db.repository,
    trust: f.trust,
    now: () => wall,
    monotonic: () => time,
    reportFailure: () => {},
    transport: {
      poll: async () => {
        entered.resolve();
        await release.promise;
        return null;
      },
      deliver: async () => assert.fail("late output"),
    },
  });
  await service.authorize(auth);
  await entered.promise;
  time = 3600001;
  wall -= 3600000;
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.status(auth)).state, "expired");
  await service.close();
});
test("a wrong support proof stops the session without executing or returning any result", async () => {
  const f = proofFixture(),
    db = repositoryFixture(),
    auth = actorFixture();
  let failures = 0;
  const service = createAssistanceService({
    repository: db.repository,
    trust: f.trust,
    now: () => f.now,
    reportFailure: () => {
      failures++;
    },
    transport: {
      poll: async () => f.signed(),
      deliver: async () => assert.fail("unauthorized output"),
    },
  });
  await service.authorize(auth);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.status(auth)).state, "interrupted");
  assert.equal(db.calls.includes("runtime.health"), false);
  assert.equal(failures, 1);
  await service.close();
});
