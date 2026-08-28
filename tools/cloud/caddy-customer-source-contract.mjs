import { DEFAULT_CLOUD_ENVIRONMENT_PROFILE } from "./cloud-environment-profile.mjs";

const DESK_HOST = DEFAULT_CLOUD_ENVIRONMENT_PROFILE.endpoints.deskTlsServerName;
const DESK_LISTENER = ":443";
const DESK_PATHS = Object.freeze(["/api/*", "/health", "/v1/*"]);
const UPSTREAM = new URL(DEFAULT_CLOUD_ENVIRONMENT_PROFILE.endpoints.deskLoopbackOrigin).host;
const CLIENT_IP_HEADER = "x-laundry-proxy-client-ip";
const REMOTE_HOST = "{http.request.remote.host}";
const REQUIRED_DELETES = Object.freeze(["forwarded", "x-forwarded-*", "x-real-ip"]);
const MAX_NAMED_ROUTES = 128;
const MAX_INVOKE_DEPTH = 16;
const MAX_CONTROL_FLOW_STEPS = 1024;
const CONTINUE = "continue";
const HANDLED = "handled";
const PROXIED = "proxied";
const INVALID = "invalid";
const CONTINUING_HANDLERS = new Set(["encode", "headers", "metrics", "tracing", "vars"]);
const STATIC_HANDLERS = new Set(["error", "file_server", "static_response"]);
const DESK_REQUESTS = Object.freeze([
  Object.freeze({ host: DESK_HOST, path: "/health" }),
  Object.freeze({ host: DESK_HOST, path: "/api/__laundry_contract__" }),
  Object.freeze({ host: DESK_HOST, path: "/v1/__laundry_contract__" }),
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedStrings(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value].sort()
    : null;
}

function exactStrings(value, expected) {
  const actual = sortedStrings(value);
  const wanted = [...expected].sort();
  return actual !== null && JSON.stringify(actual) === JSON.stringify(wanted);
}

function exactDeskHostRoute(route) {
  if (!isRecord(route) || route.terminal !== true || !Array.isArray(route.match)) return false;
  if (route.match.length !== 1 || !isRecord(route.match[0])) return false;
  return Object.keys(route.match[0]).length === 1 && exactStrings(route.match[0].host, [DESK_HOST]);
}

function childRoutes(value) {
  if (!isRecord(value)) return [];
  const direct = Array.isArray(value.routes) ? value.routes : [];
  const handled = Array.isArray(value.handle)
    ? value.handle.flatMap((handler) => childRoutes(handler))
    : [];
  return [...direct, ...direct.flatMap((route) => childRoutes(route)), ...handled];
}

function exactDeskPathRoute(route) {
  if (!isRecord(route) || !Array.isArray(route.match) || route.match.length !== 1) return false;
  const matcher = route.match[0];
  return (
    isRecord(matcher) && Object.keys(matcher).length === 1 && exactStrings(matcher.path, DESK_PATHS)
  );
}

function normalizedHeaderRecord(value) {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  const normalized = new Map(
    entries.map(([name, headerValue]) => [name.toLowerCase(), headerValue]),
  );
  return normalized.size === entries.length ? normalized : null;
}

function exactDeskProxy(proxy) {
  if (!isRecord(proxy) || proxy.handler !== "reverse_proxy") return false;
  if (
    !Array.isArray(proxy.upstreams) ||
    proxy.upstreams.length !== 1 ||
    !isRecord(proxy.upstreams[0]) ||
    proxy.upstreams[0].dial !== UPSTREAM
  ) {
    return false;
  }
  const request =
    isRecord(proxy.headers) && isRecord(proxy.headers.request) ? proxy.headers.request : null;
  if (request === null || !exactStrings(Object.keys(request), ["delete", "set"])) return false;
  const set = normalizedHeaderRecord(request.set);
  if (set === null || !exactStrings([...set.keys()], ["host", CLIENT_IP_HEADER])) return false;
  if (!exactStrings(set.get("host"), [UPSTREAM])) return false;
  if (!exactStrings(set.get(CLIENT_IP_HEADER), [REMOTE_HOST])) return false;
  const deleted = sortedStrings(request.delete)?.map((name) => name.toLowerCase());
  return deleted !== undefined && exactStrings(deleted, REQUIRED_DELETES);
}

function globMatches(value, pattern) {
  if (typeof pattern !== "string" || pattern.includes("{") || pattern.includes("}")) return null;
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "u").test(value);
}

function hostMatches(value, pattern) {
  if (typeof pattern !== "string" || pattern.includes("{") || pattern.includes("}")) return null;
  const host = value.toLowerCase();
  const candidate = pattern.toLowerCase();
  if (candidate === "*") return true;
  if (!candidate.includes("*")) return host === candidate;
  if (!candidate.startsWith("*.") || candidate.slice(2).includes("*")) return null;
  return host.endsWith(candidate.slice(1));
}

function listMatch(value, expected, matcher) {
  if (!Array.isArray(value) || value.length === 0) return null;
  let unknown = false;
  for (const candidate of value) {
    const matched = matcher(expected, candidate);
    if (matched === true) return true;
    if (matched === null) unknown = true;
  }
  return unknown ? null : false;
}

function requestMatchesMatcher(matcher, request) {
  if (!isRecord(matcher)) return null;
  let unknown = false;
  for (const [name, value] of Object.entries(matcher)) {
    const matched =
      name === "host"
        ? listMatch(value, request.host, hostMatches)
        : name === "path"
          ? listMatch(value, request.path, globMatches)
          : null;
    if (matched === false) return false;
    if (matched === null) unknown = true;
  }
  return unknown ? null : true;
}

function requestMatchesRoute(route, request) {
  if (!Object.prototype.hasOwnProperty.call(route, "match")) return true;
  if (!Array.isArray(route.match)) return null;
  if (route.match.length === 0) return true;
  let unknown = false;
  for (const matcher of route.match) {
    const matched = requestMatchesMatcher(matcher, request);
    if (matched === true) return true;
    if (matched === null) unknown = true;
  }
  return unknown ? null : false;
}

function controlFlowResult(status, targetProxy = false) {
  return Object.freeze({ status, targetProxy });
}

function createControlFlowVerifier(namedRoutes, targetRoute) {
  let steps = 0;
  let invokes = 0;

  function spendStep() {
    steps += 1;
    return steps <= MAX_CONTROL_FLOW_STEPS;
  }

  function evaluateRoutes(routes, request, invokeStack, insideTarget = false) {
    if (!Array.isArray(routes)) return controlFlowResult(INVALID);
    let matchedGroups = Object.freeze([]);
    for (const route of routes) {
      if (!spendStep() || !isRecord(route)) return controlFlowResult(INVALID);
      if (route.group !== undefined && typeof route.group !== "string") {
        return controlFlowResult(INVALID);
      }
      if (typeof route.group === "string" && matchedGroups.includes(route.group)) continue;
      const matched = requestMatchesRoute(route, request);
      if (matched === null) return controlFlowResult(INVALID);
      if (!matched) continue;
      if (typeof route.group === "string") {
        matchedGroups = Object.freeze([...matchedGroups, route.group]);
      }
      if (route.terminal !== undefined && typeof route.terminal !== "boolean") {
        return controlFlowResult(INVALID);
      }
      const result = evaluateHandlers(
        route.handle,
        request,
        invokeStack,
        insideTarget || route === targetRoute,
      );
      if (result.status !== CONTINUE) return result;
      if (route.terminal === true) return controlFlowResult(HANDLED);
    }
    return controlFlowResult(CONTINUE);
  }

  function evaluateInvoke(handler, request, invokeStack, insideTarget) {
    if (typeof handler.name !== "string" || handler.name.length === 0) {
      return controlFlowResult(INVALID);
    }
    if (
      invokeStack.length >= MAX_INVOKE_DEPTH ||
      invokes >= MAX_NAMED_ROUTES ||
      invokeStack.includes(handler.name) ||
      !Object.prototype.hasOwnProperty.call(namedRoutes, handler.name)
    ) {
      return controlFlowResult(INVALID);
    }
    const namedRoute = namedRoutes[handler.name];
    if (!isRecord(namedRoute)) return controlFlowResult(INVALID);
    invokes += 1;
    return evaluateRoutes(
      [namedRoute],
      request,
      Object.freeze([...invokeStack, handler.name]),
      insideTarget,
    );
  }

  function evaluateHandler(handler, request, invokeStack, insideTarget) {
    if (!isRecord(handler) || typeof handler.handler !== "string") {
      return controlFlowResult(INVALID);
    }
    if (handler.handler === "reverse_proxy") {
      return exactDeskProxy(handler)
        ? controlFlowResult(PROXIED, insideTarget)
        : controlFlowResult(INVALID);
    }
    if (handler.handler === "subroute") {
      return evaluateRoutes(handler.routes, request, invokeStack, insideTarget);
    }
    if (handler.handler === "invoke") {
      return evaluateInvoke(handler, request, invokeStack, insideTarget);
    }
    if (CONTINUING_HANDLERS.has(handler.handler)) return controlFlowResult(CONTINUE);
    if (STATIC_HANDLERS.has(handler.handler)) return controlFlowResult(HANDLED);
    return controlFlowResult(INVALID);
  }

  function evaluateHandlers(value, request, invokeStack, insideTarget) {
    if (value === undefined) return controlFlowResult(CONTINUE);
    if (!Array.isArray(value)) return controlFlowResult(INVALID);
    for (const handler of value) {
      if (!spendStep()) return controlFlowResult(INVALID);
      const result = evaluateHandler(handler, request, invokeStack, insideTarget);
      if (result.status !== CONTINUE) return result;
    }
    return controlFlowResult(CONTINUE);
  }

  return (routesBeforeDesk, deskRoute, request) => {
    const prefix = evaluateRoutes(routesBeforeDesk, request, Object.freeze([]));
    if (prefix.status !== CONTINUE) return false;
    const result = evaluateHandlers(deskRoute.handle, request, Object.freeze([]), false);
    return result.status === PROXIED && result.targetProxy;
  };
}

/** Verify the one reachable Desk API route, not an arbitrary decoy proxy object. */
export function hasCustomerSourceAuthority(adapted) {
  const servers = adapted?.apps?.http?.servers;
  if (!isRecord(servers)) return false;
  const candidates = [];
  for (const server of Object.values(servers)) {
    if (!isRecord(server) || !Array.isArray(server.routes)) continue;
    server.routes.forEach((route, index) => {
      if (exactDeskHostRoute(route)) candidates.push({ server, route, index });
    });
  }
  if (candidates.length !== 1) return false;
  const [{ server, route, index }] = candidates;
  if (!exactStrings(server.listen, [DESK_LISTENER])) return false;
  const nestedRoutes = childRoutes(route);
  const pathRoutes = nestedRoutes.filter(exactDeskPathRoute);
  if (pathRoutes.length !== 1) return false;
  const namedRoutes = server.named_routes === undefined ? Object.freeze({}) : server.named_routes;
  if (!isRecord(namedRoutes) || Object.keys(namedRoutes).length > MAX_NAMED_ROUTES) return false;
  const verify = createControlFlowVerifier(namedRoutes, pathRoutes[0]);
  const routesBeforeDesk = server.routes.slice(0, index);
  return DESK_REQUESTS.every((request) => verify(routesBeforeDesk, route, request));
}

export function parseCaddyCustomerSourceAuthority(source) {
  if (typeof source !== "string" || source.length < 2 || source.length > 4 * 1024 * 1024) {
    return false;
  }
  try {
    return hasCustomerSourceAuthority(JSON.parse(source));
  } catch {
    return false;
  }
}
