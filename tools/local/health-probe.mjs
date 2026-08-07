const DOWN = Object.freeze({ reachable: false, ready: false });
const REACHABLE = Object.freeze({ reachable: true, ready: false });
const READY = Object.freeze({ reachable: true, ready: true });
const MAXIMUM_HEALTH_BYTES = 8 * 1024;

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

async function readBoundedJson(response) {
  if (response.body === null) throw new Error("HEALTH_BODY_MISSING");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAXIMUM_HEALTH_BYTES) {
        await reader.cancel();
        throw new Error("HEALTH_BODY_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
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
    return isReadyEnvelope(await readBoundedJson(response)) ? READY : REACHABLE;
  } catch {
    return REACHABLE;
  }
}
