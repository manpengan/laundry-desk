const DOWN = Object.freeze({ reachable: false, ready: false });
const REACHABLE = Object.freeze({ reachable: true, ready: false });
const READY = Object.freeze({ reachable: true, ready: true });

function isReadyEnvelope(body) {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    body.ok === true &&
    body.data?.status === "ready" &&
    Object.keys(body).length === 2
  );
}

export async function probeHealthEndpoint(url, fetchImplementation = fetch) {
  let response;
  try {
    response = await fetchImplementation(url, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return DOWN;
  }

  try {
    if (!response.ok) return REACHABLE;
    return isReadyEnvelope(await response.json()) ? READY : REACHABLE;
  } catch {
    return REACHABLE;
  }
}
