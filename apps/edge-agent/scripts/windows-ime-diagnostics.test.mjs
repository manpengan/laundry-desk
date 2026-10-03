import assert from "node:assert/strict";
import test from "node:test";

import {
  allowsUntrustedNativeImeEnd,
  captureImeDiagnostics,
  isAcceptedImeComposition,
  projectImeDiagnostics,
} from "../e2e/windows-ime-diagnostics.mjs";

const invalid = Object.freeze({ available: false, reason: "invalid_observation" });
const event = (type, overrides = {}) => ({
  type,
  trusted: true,
  commitsExpectedText: type === "compositionend",
  composing: type === "input",
  ...overrides,
});
const observed = (overrides = {}) => ({
  hasExpectedText: true,
  overflow: false,
  events: [
    event("compositionstart"),
    event("compositionupdate"),
    event("input"),
    event("compositionend"),
    event("input", { composing: false }),
  ],
  inputConnected: true,
  inputIsCurrent: true,
  auditIntact: true,
  scriptDispatchedEvents: 0,
  ...overrides,
});

test("complete trusted composition projects only finite flags and counts", () => {
  const raw = observed();
  const result = projectImeDiagnostics(raw);
  assert.deepEqual(result, {
    available: true,
    hasExpectedText: true,
    overflow: false,
    inputConnected: true,
    inputIsCurrent: true,
    auditIntact: true,
    scriptDispatchedEvents: 0,
    event_count: 5,
    trusted_compositionstart: 1,
    trusted_compositionupdate: 1,
    trusted_compositionend: 1,
    trusted_input: 2,
    expectedCommit: 1,
    untrustedEnd: 0,
    expectedEnd: 1,
    isComposingInput: 1,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal("events" in result, false);
  assert.equal(raw.events.length, 5);
});

test("missing composing input remains a valid observation with zero count", () => {
  const result = projectImeDiagnostics(
    observed({
      events: [
        event("compositionstart"),
        event("compositionend"),
        event("input", { composing: false }),
      ],
    }),
  );
  assert.equal(result.available, true);
  assert.equal(result.isComposingInput, 0);
  assert.equal(result.expectedCommit, 1);
});

test("untrusted events do not contribute to trusted or commit counts", () => {
  const result = projectImeDiagnostics(
    observed({
      events: [
        event("compositionstart", { trusted: false }),
        event("compositionend", { trusted: false }),
        event("input", { trusted: false }),
      ],
    }),
  );
  assert.equal(result.event_count, 3);
  assert.equal(result.trusted_compositionstart, 0);
  assert.equal(result.trusted_compositionend, 0);
  assert.equal(result.trusted_input, 0);
  assert.equal(result.expectedCommit, 0);
  assert.equal(result.untrustedEnd, 1);
  assert.equal(result.expectedEnd, 1);
  assert.equal(result.isComposingInput, 0);
});

test("disconnected/replaced input and overflow remain explicit diagnostic flags", () => {
  assert.equal(projectImeDiagnostics(observed({ inputConnected: false })).inputConnected, false);
  assert.equal(projectImeDiagnostics(observed({ inputIsCurrent: false })).inputIsCurrent, false);
  assert.equal(projectImeDiagnostics(observed({ overflow: true })).overflow, true);
  assert.equal(projectImeDiagnostics(observed({ hasExpectedText: false })).hasExpectedText, false);
});

test("empty and 64-event observations are valid, 65 events reject", () => {
  assert.equal(projectImeDiagnostics(observed({ events: [] })).event_count, 0);
  assert.equal(
    projectImeDiagnostics(observed({ events: Array.from({ length: 64 }, () => event("input")) }))
      .event_count,
    64,
  );
  assert.deepEqual(
    projectImeDiagnostics(observed({ events: Array.from({ length: 65 }, () => event("input")) })),
    invalid,
  );
});

test("invalid raw structure and exact field boundary reject", () => {
  const { inputConnected: removed, ...missing } = observed();
  assert.equal(removed, true);
  for (const raw of [
    null,
    undefined,
    0,
    "unexpected text",
    [],
    {},
    missing,
    observed({ events: {} }),
    observed({ events: null }),
  ])
    assert.deepEqual(projectImeDiagnostics(raw), invalid);
});

test("every raw and event boolean must be a boolean", () => {
  for (const key of [
    "hasExpectedText",
    "overflow",
    "inputConnected",
    "inputIsCurrent",
    "auditIntact",
  ])
    assert.deepEqual(projectImeDiagnostics(observed({ [key]: "true" })), invalid);
  for (const key of ["trusted", "commitsExpectedText", "composing"])
    assert.deepEqual(
      projectImeDiagnostics(observed({ events: [event("input", { [key]: 1 })] })),
      invalid,
    );
});

test("script dispatch diagnostics accept only bounded integer counts", () => {
  for (const scriptDispatchedEvents of ["0", true, null, -1, 0.5, NaN, Infinity, 66])
    assert.deepEqual(projectImeDiagnostics(observed({ scriptDispatchedEvents })), invalid);
  for (const scriptDispatchedEvents of [0, 1, 65])
    assert.equal(
      projectImeDiagnostics(observed({ scriptDispatchedEvents })).scriptDispatchedEvents,
      scriptDispatchedEvents,
    );
});

const knownEngine = Object.freeze({ electron: "41.10.6", chrome: "146.0.7680.216" });
const queuedNativeEnd = () =>
  observed({
    events: [
      event("compositionstart"),
      ...Array.from({ length: 6 }, () => [event("compositionupdate"), event("input")]).flat(),
      event("compositionend", { trusted: false }),
    ],
  });

test("exact engine admits an audited queued end after the trusted native sequence", () => {
  assert.equal(isAcceptedImeComposition(queuedNativeEnd(), knownEngine), true);
  const diagnostic = projectImeDiagnostics(queuedNativeEnd());
  assert.equal(diagnostic.event_count, 14);
  assert.equal(diagnostic.trusted_compositionstart, 1);
  assert.equal(diagnostic.trusted_compositionupdate, 6);
  assert.equal(diagnostic.isComposingInput, 6);
  assert.equal(diagnostic.expectedCommit, 0);
  assert.equal(diagnostic.untrustedEnd, 1);
  assert.equal(diagnostic.expectedEnd, 1);
});

test("engine exception requires the exact pair and never weakens unknown engines", () => {
  assert.equal(allowsUntrustedNativeImeEnd(knownEngine), true);
  for (const engine of [
    undefined,
    null,
    {},
    "41.10.6",
    [knownEngine],
    { ...knownEngine, electron: "41.10.7" },
    { ...knownEngine, chrome: "146.0.7680.217" },
    { ...knownEngine, extra: true },
    Object.create(knownEngine),
    Object.defineProperty({ ...knownEngine }, "electron", {
      get: () => {
        throw new Error("not read");
      },
    }),
  ]) {
    assert.equal(allowsUntrustedNativeImeEnd(engine), false);
    assert.equal(isAcceptedImeComposition(queuedNativeEnd(), engine), false);
    assert.equal(isAcceptedImeComposition(observed(), engine), true);
  }
});

test("script dispatch, missing audit, overflow and replaced inputs always reject", () => {
  for (const overrides of [
    { auditIntact: false },
    { scriptDispatchedEvents: 1 },
    { scriptDispatchedEvents: 65 },
    { overflow: true },
    { inputConnected: false },
    { inputIsCurrent: false },
    { hasExpectedText: false },
    { auditIntact: "true" },
    { scriptDispatchedEvents: "0" },
  ]) {
    assert.equal(isAcceptedImeComposition(observed(overrides), knownEngine), false);
    assert.equal(
      isAcceptedImeComposition({ ...queuedNativeEnd(), ...overrides }, knownEngine),
      false,
    );
  }
  const { auditIntact: omitted, ...withoutAudit } = queuedNativeEnd();
  assert.equal(omitted, true);
  assert.equal(isAcceptedImeComposition(withoutAudit, knownEngine), false);
});

test("native sequence requires start then trusted update and composing input before expected end", () => {
  const start = event("compositionstart");
  const update = event("compositionupdate");
  const input = event("input");
  const end = event("compositionend", { trusted: false });
  for (const events of [
    [],
    [end],
    [start, end],
    [start, update, end],
    [start, input, end],
    [update, start, input, end],
    [start, input, update, end],
    [start, update, end, input],
    [start, update, input],
    [start, update, input, { ...end, commitsExpectedText: false }],
    [{ ...start, trusted: false }, update, input, end],
    [start, { ...update, trusted: false }, input, end],
    [start, update, { ...input, trusted: false }, end],
    [start, update, { ...input, composing: false }, end],
    [start, update, input, { ...end, composing: true }],
    [{ ...start, composing: true }, update, input, end],
    [start, { ...update, commitsExpectedText: true }, input, end],
    [start, update, input, end, update],
    [start, update, input, end, input],
    [start, update, input, end, start],
    [start, update, input, end, end],
  ])
    assert.equal(isAcceptedImeComposition(observed({ events }), knownEngine), false);
  assert.equal(
    isAcceptedImeComposition(observed({ events: [start, update, input, end] }), knownEngine),
    true,
  );
  assert.equal(
    isAcceptedImeComposition(
      observed({ events: [start, update, input, end, event("input", { composing: false })] }),
      knownEngine,
    ),
    true,
  );
});

test("unknown or incomplete event types/fields reject", () => {
  const { composing: removed, ...missing } = event("input");
  assert.equal(removed, true);
  for (const events of [[event("keydown")], [event(1)], [missing], [null], ["unexpected text"]])
    assert.deepEqual(projectImeDiagnostics(observed({ events })), invalid);
});

test("extra fields carrying text or exceptions are rejected without echo", () => {
  const secret = "SYNTHETIC-UNEXPECTED-INPUT-NOT-FOR-DIAGNOSTICS";
  for (const raw of [
    observed({ text: secret }),
    observed({ exception: new Error(secret) }),
    observed({ events: [event("input", { data: secret })] }),
  ]) {
    const result = projectImeDiagnostics(raw);
    assert.deepEqual(result, invalid);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("symbols, hidden fields, sparse arrays, and accessor observations reject", () => {
  const symbolRaw = { ...observed(), [Symbol("synthetic secret")]: "synthetic" };
  const hidden = Object.defineProperty(observed(), "text", {
    value: "synthetic",
    enumerable: false,
  });
  let getterCalled = false;
  const accessor = Object.defineProperty(observed(), "hasExpectedText", {
    get() {
      getterCalled = true;
      throw new Error("synthetic");
    },
  });
  const events = new Array(1);
  const arrayExtra = Object.assign([event("input")], { text: "synthetic" });
  for (const raw of [
    symbolRaw,
    hidden,
    accessor,
    observed({ events }),
    observed({ events: arrayExtra }),
  ])
    assert.deepEqual(projectImeDiagnostics(raw), invalid);
  assert.equal(getterCalled, false);
});

test("commit and composing counts retain the original strict event semantics", () => {
  const result = projectImeDiagnostics(
    observed({
      events: [
        event("compositionupdate", { commitsExpectedText: true, composing: true }),
        event("input", { commitsExpectedText: true, composing: false }),
      ],
    }),
  );
  assert.equal(result.expectedCommit, 0);
  assert.equal(result.isComposingInput, 0);
});

test("capture preserves valid/invalid observations and separates read failure", async () => {
  assert.deepEqual(
    await captureImeDiagnostics(async () => observed()),
    projectImeDiagnostics(observed()),
  );
  assert.deepEqual(await captureImeDiagnostics(async () => null), invalid);
  const result = await captureImeDiagnostics(async () => {
    throw new Error("SYNTHETIC-SECRET-READ-ERROR");
  });
  assert.deepEqual(result, { available: false, reason: "observation_unavailable" });
  assert.equal(JSON.stringify(result).includes("SYNTHETIC-SECRET-READ-ERROR"), false);
});

test("diagnostic capture times out a pending reader after the fixed short deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finished = false;
  let value;
  const capture = captureImeDiagnostics(() => new Promise(() => {})).then((result) => {
    finished = true;
    value = result;
  });
  t.mock.timers.tick(1999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, true);
  assert.deepEqual(value, { available: false, reason: "observation_unavailable" });
  await capture;
});

test("a timed-out reader's late rejection is handled without diagnostic text or errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectLate;
  const read = new Promise((_, reject) => {
    rejectLate = reject;
  });
  const capture = captureImeDiagnostics(() => read);
  t.mock.timers.tick(2000);
  const result = await capture;
  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    rejectLate(new Error("SYNTHETIC-LATE-SECRET-REJECTION"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, 0);
    assert.deepEqual(result, { available: false, reason: "observation_unavailable" });
    assert.equal(JSON.stringify(result).includes("SYNTHETIC-LATE-SECRET-REJECTION"), false);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("fast successful observation clears its timer and retains the original API", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled = t.mock.method(globalThis, "setTimeout");
  const cleared = t.mock.method(globalThis, "clearTimeout");
  assert.deepEqual(
    await captureImeDiagnostics(async () => observed()),
    projectImeDiagnostics(observed()),
  );
  assert.equal(scheduled.mock.callCount(), 1);
  assert.equal(scheduled.mock.calls[0].arguments[1], 2000);
  assert.equal(cleared.mock.callCount(), 1);
  assert.equal(cleared.mock.calls[0].arguments[0], scheduled.mock.calls[0].result);
  t.mock.timers.tick(2000);
});
