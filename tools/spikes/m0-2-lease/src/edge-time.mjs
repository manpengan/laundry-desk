function disabled(reason) {
  return Object.freeze({ enabled: false, reason });
}

function isContinuityIdentity(value) {
  return (
    value &&
    typeof value.bootId === "string" &&
    value.bootId.length > 0 &&
    typeof value.processId === "string" &&
    value.processId.length > 0 &&
    Number.isSafeInteger(value.wakeSequence) &&
    value.wakeSequence >= 0 &&
    Number.isFinite(value.wallMs)
  );
}

function isSignedLeaseTimeValid(lease) {
  return (
    lease &&
    typeof lease.lease_id === "string" &&
    lease.lease_id.length > 0 &&
    typeof lease.store_id === "string" &&
    lease.store_id.length > 0 &&
    typeof lease.device_id === "string" &&
    lease.device_id.length > 0 &&
    Number.isSafeInteger(lease.primary_epoch) &&
    lease.primary_epoch > 0 &&
    Number.isSafeInteger(lease.ttl_ms) &&
    lease.ttl_ms > 0 &&
    Number.isSafeInteger(lease.max_clock_skew_ms) &&
    lease.max_clock_skew_ms >= 0
  );
}

function hasValidSignature(lease, verifyLease) {
  try {
    return typeof verifyLease === "function" && verifyLease(lease);
  } catch {
    return false;
  }
}

function signedTimesAgree(lease) {
  const issuedAtMs = Date.parse(lease.issued_at);
  const notAfterMs = Date.parse(lease.not_after);
  return (
    Number.isFinite(issuedAtMs) &&
    new Date(issuedAtMs).toISOString() === lease.issued_at &&
    Number.isFinite(notAfterMs) &&
    new Date(notAfterMs).toISOString() === lease.not_after &&
    notAfterMs === issuedAtMs + lease.ttl_ms
  );
}

function requestContinuityLost(input) {
  const { requestStartContinuity, continuity, lease } = input;
  if (requestStartContinuity.bootId !== continuity.bootId) return true;
  if (requestStartContinuity.processId !== continuity.processId) return true;
  if (requestStartContinuity.wakeSequence !== continuity.wakeSequence)
    return true;
  const monotonicDelta = input.responseMonoMs - input.requestStartMonoMs;
  const wallDelta = continuity.wallMs - requestStartContinuity.wallMs;
  return Math.abs(wallDelta - monotonicDelta) > lease.max_clock_skew_ms;
}

function hasValidSafetyMargin(lease, safetyMarginMs) {
  return (
    Number.isFinite(safetyMarginMs) &&
    safetyMarginMs >= 0 &&
    safetyMarginMs < lease.ttl_ms
  );
}

function enabledSession(input, localDeadlineMonoMs) {
  const { lease, requestStartMonoMs, responseMonoMs, continuity } = input;
  const session = Object.freeze({
    lease: Object.freeze({ ...lease }),
    localDeadlineMonoMs,
    authorizedDurationMs: localDeadlineMonoMs - requestStartMonoMs,
    bootId: continuity.bootId,
    processId: continuity.processId,
    wakeSequence: continuity.wakeSequence,
    lastMonoMs: responseMonoMs,
    lastWallMs: continuity.wallMs,
    invalidated: false,
  });
  return Object.freeze({ enabled: true, session });
}

export function createLeaseSession(input) {
  const {
    lease,
    requestStartMonoMs,
    responseMonoMs,
    safetyMarginMs,
    requestStartContinuity,
    continuity,
    verifyLease,
  } = input;
  if (!hasValidSignature(lease, verifyLease)) {
    return disabled("invalid-lease-signature");
  }
  if (!isSignedLeaseTimeValid(lease)) {
    return disabled("invalid-signed-lease");
  }
  if (
    !Number.isFinite(requestStartMonoMs) ||
    !Number.isFinite(responseMonoMs) ||
    !isContinuityIdentity(requestStartContinuity) ||
    !isContinuityIdentity(continuity)
  ) {
    return disabled("continuity-unprovable");
  }
  if (!hasValidSafetyMargin(lease, safetyMarginMs)) {
    return disabled("invalid-safety-margin");
  }
  if (!signedTimesAgree(lease)) {
    return disabled("signed-time-mismatch");
  }
  if (requestContinuityLost(input)) {
    return disabled("request-continuity-lost");
  }
  const roundTripMs = responseMonoMs - requestStartMonoMs;
  if (roundTripMs < 0) return disabled("monotonic-regressed");
  if (roundTripMs >= lease.ttl_ms) return disabled("rtt-at-least-ttl");

  const localDeadlineMonoMs =
    requestStartMonoMs + lease.ttl_ms - safetyMarginMs;
  if (responseMonoMs >= localDeadlineMonoMs) {
    return disabled("deadline-reached-before-response");
  }

  return enabledSession(input, localDeadlineMonoMs);
}

function invalidated(session, reason) {
  const nextSession = Object.freeze({ ...session, invalidated: true });
  return Object.freeze({
    allowed: false,
    mode: "online-only",
    reason,
    session: nextSession,
  });
}

function continuityFailure(session, observation) {
  if (observation.bootId !== session.bootId) return "boot-changed";
  if (observation.processId !== session.processId) return "process-changed";
  if (observation.wakeSequence !== session.wakeSequence)
    return "wake-sequence-changed";
  if (observation.monoMs >= session.localDeadlineMonoMs) return "lease-expired";
  if (observation.monoMs < session.lastMonoMs) return "monotonic-regressed";

  const monotonicDelta = observation.monoMs - session.lastMonoMs;
  const wallDelta = observation.wallMs - session.lastWallMs;
  if (Math.abs(wallDelta - monotonicDelta) > session.lease.max_clock_skew_ms) {
    return "clock-discontinuity";
  }
  return undefined;
}

export function authorizeOffline(session, observation) {
  if (!session || session.invalidated) {
    return invalidated(session ?? {}, "session-invalidated");
  }
  if (
    !isContinuityIdentity(observation) ||
    !Number.isFinite(observation.monoMs)
  ) {
    return invalidated(session, "continuity-unprovable");
  }
  const reason = continuityFailure(session, observation);
  if (reason) {
    return invalidated(session, reason);
  }

  const nextSession = Object.freeze({
    ...session,
    lastMonoMs: observation.monoMs,
    lastWallMs: observation.wallMs,
  });
  return Object.freeze({
    allowed: true,
    mode: "offline",
    session: nextSession,
  });
}
