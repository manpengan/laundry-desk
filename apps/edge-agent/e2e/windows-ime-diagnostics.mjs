/** @typedef {'compositionstart' | 'compositionupdate' | 'compositionend' | 'input'} ImeEventType */
/** @typedef {Readonly<{type: ImeEventType, trusted: boolean, commitsExpectedText: boolean, composing: boolean}>} ImeEvent */
/** @typedef {Readonly<{hasExpectedText: boolean, overflow: boolean, events: readonly ImeEvent[], inputConnected: boolean, inputIsCurrent: boolean, auditIntact: boolean, scriptDispatchedEvents: number}>} ImeObservation */
/** @typedef {Readonly<{available: false, reason: 'invalid_observation' | 'observation_unavailable'}>} UnavailableDiagnostics */
/** @typedef {Readonly<{available: true, hasExpectedText: boolean, overflow: boolean, inputConnected: boolean, inputIsCurrent: boolean, auditIntact: boolean, scriptDispatchedEvents: number, event_count: number, trusted_compositionstart: number, trusted_compositionupdate: number, trusted_compositionend: number, trusted_input: number, expectedCommit: number, untrustedEnd: number, expectedEnd: number, isComposingInput: number}>} AvailableDiagnostics */
/** @typedef {AvailableDiagnostics | UnavailableDiagnostics} ImeDiagnostics */

const OBSERVATION_KEYS = Object.freeze([
  "hasExpectedText",
  "overflow",
  "events",
  "inputConnected",
  "inputIsCurrent",
  "auditIntact",
  "scriptDispatchedEvents",
]);
const EVENT_KEYS = Object.freeze(["type", "trusted", "commitsExpectedText", "composing"]);
const MAX_EVENTS = 64;
const OBSERVATION_DEADLINE_MS = 2000;

/** @param {object} value @param {string} key @returns {unknown} */
function dataValue(value, key) {
  /** @type {Readonly<{value?: unknown}> | undefined} */
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
    throw new Error("INVALID_IME_OBSERVATION");
  return descriptor.value;
}

/** @param {unknown} value @param {readonly string[]} keys @returns {Readonly<Record<string, unknown>> | null} */
function exactRecord(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return null;
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, dataValue(value, key)])));
}

/** @param {unknown} value @returns {ImeEvent | null} */
function readEvent(value) {
  const event = exactRecord(value, EVENT_KEYS);
  if (event === null) return null;
  const { type, trusted, commitsExpectedText, composing } = event;
  if (
    (type !== "compositionstart" &&
      type !== "compositionupdate" &&
      type !== "compositionend" &&
      type !== "input") ||
    typeof trusted !== "boolean" ||
    typeof commitsExpectedText !== "boolean" ||
    typeof composing !== "boolean"
  )
    return null;
  return Object.freeze({ type, trusted, commitsExpectedText, composing });
}

/** @param {unknown} value @returns {readonly ImeEvent[] | null} */
function readEvents(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = dataValue(value, "length");
  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > MAX_EVENTS ||
    Reflect.ownKeys(value).length !== length + 1
  )
    return null;
  const events = Array.from({ length }, (_, index) => readEvent(dataValue(value, String(index))));
  if (events.some((event) => event === null)) return null;
  return /** @type {readonly ImeEvent[]} */ (events);
}

/** @param {unknown} observation @returns {ImeObservation | null} */
function readObservation(observation) {
  try {
    const raw = exactRecord(observation, OBSERVATION_KEYS);
    if (raw === null) return null;
    const {
      hasExpectedText,
      overflow,
      inputConnected,
      inputIsCurrent,
      auditIntact,
      scriptDispatchedEvents,
    } = raw;
    const events = readEvents(raw.events);
    if (
      events === null ||
      typeof hasExpectedText !== "boolean" ||
      typeof overflow !== "boolean" ||
      typeof inputConnected !== "boolean" ||
      typeof inputIsCurrent !== "boolean" ||
      typeof auditIntact !== "boolean" ||
      typeof scriptDispatchedEvents !== "number" ||
      !Number.isInteger(scriptDispatchedEvents) ||
      scriptDispatchedEvents < 0 ||
      scriptDispatchedEvents > MAX_EVENTS + 1
    )
      return null;
    return Object.freeze({
      hasExpectedText,
      overflow,
      events,
      inputConnected,
      inputIsCurrent,
      auditIntact,
      scriptDispatchedEvents,
    });
  } catch {
    return null;
  }
}

/** @param {unknown} versions @returns {boolean} */
export function allowsUntrustedNativeImeEnd(versions) {
  try {
    const engine = exactRecord(versions, ["electron", "chrome"]);
    // Chromium's queued compositionend omits SetTrusted in this exact engine build.
    // https://github.com/chromium/chromium/blob/146.0.7680.216/third_party/blink/renderer/core/editing/ime/input_method_controller.cc#L393
    return engine?.electron === "41.10.6" && engine.chrome === "146.0.7680.216";
  } catch {
    return false;
  }
}

/** @param {readonly ImeEvent[]} events @param {boolean} allowUntrustedEnd @returns {boolean} */
function hasOrderedComposition(events, allowUntrustedEnd) {
  let started = false;
  let updated = false;
  let composingInput = false;
  let ended = false;
  for (const event of events) {
    if (event.type !== "compositionend" && (!event.trusted || event.commitsExpectedText))
      return false;
    if (event.type === "compositionstart") {
      if (started || event.composing) return false;
      started = true;
    } else if (event.type === "compositionupdate") {
      if (!started || ended || event.composing) return false;
      updated = true;
    } else if (event.type === "input") {
      if (!started || !updated || event.composing === ended) return false;
      if (event.composing) composingInput = true;
    } else {
      if (
        !started ||
        !updated ||
        !composingInput ||
        ended ||
        event.composing ||
        !event.commitsExpectedText ||
        (!event.trusted && !allowUntrustedEnd)
      )
        return false;
      ended = true;
    }
  }
  return ended;
}

/** @param {unknown} observation @param {unknown} versions @returns {boolean} */
export function isAcceptedImeComposition(observation, versions) {
  const raw = readObservation(observation);
  return (
    raw !== null &&
    raw.hasExpectedText &&
    !raw.overflow &&
    raw.inputConnected &&
    raw.inputIsCurrent &&
    raw.auditIntact &&
    raw.scriptDispatchedEvents === 0 &&
    hasOrderedComposition(raw.events, allowsUntrustedNativeImeEnd(versions))
  );
}

/** @param {unknown} observation @returns {ImeDiagnostics} */
export function projectImeDiagnostics(observation) {
  const raw = readObservation(observation);
  if (raw === null) return Object.freeze({ available: false, reason: "invalid_observation" });
  const {
    hasExpectedText,
    overflow,
    events,
    inputConnected,
    inputIsCurrent,
    auditIntact,
    scriptDispatchedEvents,
  } = raw;
  const trusted = events.filter((event) => event.trusted);
  return Object.freeze({
    available: true,
    hasExpectedText,
    overflow,
    inputConnected,
    inputIsCurrent,
    auditIntact,
    scriptDispatchedEvents,
    event_count: events.length,
    trusted_compositionstart: trusted.filter((event) => event.type === "compositionstart").length,
    trusted_compositionupdate: trusted.filter((event) => event.type === "compositionupdate").length,
    trusted_compositionend: trusted.filter((event) => event.type === "compositionend").length,
    trusted_input: trusted.filter((event) => event.type === "input").length,
    expectedCommit: trusted.filter(
      (event) => event.type === "compositionend" && event.commitsExpectedText,
    ).length,
    untrustedEnd: events.filter((event) => event.type === "compositionend" && !event.trusted)
      .length,
    expectedEnd: events.filter(
      (event) => event.type === "compositionend" && event.commitsExpectedText,
    ).length,
    isComposingInput: trusted.filter((event) => event.type === "input" && event.composing).length,
  });
}

/** @param {() => Promise<unknown>} readObservation @returns {Promise<ImeDiagnostics>} */
export async function captureImeDiagnostics(readObservation) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const observation = Promise.resolve().then(() => readObservation());
  /** @type {Promise<never>} */
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("IME_OBSERVATION_DEADLINE")),
      OBSERVATION_DEADLINE_MS,
    );
  });
  try {
    // Race installs a rejection handler on both promises, including a late reader failure.
    return projectImeDiagnostics(await Promise.race([observation, deadline]));
  } catch {
    return Object.freeze({ available: false, reason: "observation_unavailable" });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
