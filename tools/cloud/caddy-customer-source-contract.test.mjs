import assert from "node:assert/strict";
import test from "node:test";

import {
  hasCustomerSourceAuthority,
  parseCaddyCustomerSourceAuthority,
} from "./caddy-customer-source-contract.mjs";

const requiredHeaders = () => ({
  delete: ["Forwarded", "X-Forwarded-*", "X-Real-IP"],
  set: {
    Host: ["127.0.0.1:8787"],
    "X-Laundry-Proxy-Client-Ip": ["{http.request.remote.host}"],
  },
});

const reverseProxy = (request = requiredHeaders(), dial = "127.0.0.1:8787") => ({
  handler: "reverse_proxy",
  upstreams: [{ dial }],
  headers: { request },
});

const invoke = (name) => ({ handler: "invoke", name });

const apiRoute = (proxy = reverseProxy(), paths = ["/health", "/api/*", "/v1/*"]) => ({
  group: "desk",
  match: [{ path: paths }],
  handle: [{ handler: "subroute", routes: [{ handle: [proxy] }] }],
});

const hostRoute = (host, proxy = reverseProxy(), paths) => ({
  match: [{ host: [host] }],
  terminal: true,
  handle: [
    {
      handler: "subroute",
      routes: [
        apiRoute(proxy, paths),
        { group: "desk", handle: [{ handler: "subroute", routes: [] }] },
      ],
    },
  ],
});

const adapted = (desk = hostRoute("desk.manpengan.xyz"), before = []) => ({
  apps: {
    http: {
      servers: {
        srv0: { listen: [":443"], routes: [...before, desk] },
      },
    },
  },
});

const withServer = (value, name, server) => ({
  ...value,
  apps: {
    ...value.apps,
    http: {
      ...value.apps.http,
      servers: { ...value.apps.http.servers, [name]: server },
    },
  },
});

const withNamedRoutes = (value, namedRoutes) => ({
  ...value,
  apps: {
    ...value.apps,
    http: {
      ...value.apps.http,
      servers: {
        ...value.apps.http.servers,
        srv0: { ...value.apps.http.servers.srv0, named_routes: namedRoutes },
      },
    },
  },
});

const prependDeskRoute = (desk, route) => ({
  ...desk,
  handle: desk.handle.map((handler) => ({
    ...handler,
    routes: [route, ...handler.routes],
  })),
});

test("binds the exact reachable Desk host and API route to one hardened proxy", () => {
  const value = adapted();
  assert.equal(hasCustomerSourceAuthority(value), true);
  assert.equal(parseCaddyCustomerSourceAuthority(JSON.stringify(value)), true);
});

test("rejects every missing delete, source overwrite, Host override or exact upstream", () => {
  const headers = requiredHeaders();
  const candidates = [
    ...headers.delete.map((name) =>
      reverseProxy({ ...headers, delete: headers.delete.filter((entry) => entry !== name) }),
    ),
    reverseProxy({ ...headers, set: { ...headers.set, Host: undefined } }),
    reverseProxy({ ...headers, set: { ...headers.set, Host: ["{http.request.host}"] } }),
    reverseProxy({
      ...headers,
      set: {
        ...headers.set,
        "X-Laundry-Proxy-Client-Ip": ["{http.request.header.X-Laundry-Proxy-Client-Ip}"],
      },
    }),
    reverseProxy(headers, "0.0.0.0:8787"),
  ];
  for (const proxy of candidates) {
    assert.equal(
      hasCustomerSourceAuthority(adapted(hostRoute("desk.manpengan.xyz", proxy))),
      false,
    );
  }
});

test("rejects a safe decoy when the actual Desk route or an earlier route is unsafe", () => {
  const unsafe = reverseProxy({ set: { Host: ["127.0.0.1:8787"] }, delete: [] });
  const decoyServer = withServer(adapted(hostRoute("desk.manpengan.xyz", unsafe)), "decoy", {
    listen: [":9443"],
    routes: [hostRoute("decoy.invalid", reverseProxy())],
  });
  assert.equal(hasCustomerSourceAuthority(decoyServer), false);
  assert.equal(
    hasCustomerSourceAuthority(adapted(undefined, [{ handle: [unsafe] }])),
    false,
    "a catch-all before the safe host route is reachable first",
  );
  assert.equal(
    hasCustomerSourceAuthority(
      adapted(hostRoute("desk.manpengan.xyz"), [hostRoute("*.manpengan.xyz", unsafe)]),
    ),
    false,
  );
});

test("rejects duplicate host routes, wrong path groups and malformed input", () => {
  const duplicate = withServer(adapted(), "srv1", {
    listen: [":443"],
    routes: [hostRoute("desk.manpengan.xyz")],
  });
  assert.equal(hasCustomerSourceAuthority(duplicate), false);
  const wrongPath = hostRoute("desk.manpengan.xyz", reverseProxy(), ["/decoy/*"]);
  assert.equal(hasCustomerSourceAuthority(adapted(wrongPath)), false);
  assert.equal(parseCaddyCustomerSourceAuthority("not-json"), false);
  assert.equal(parseCaddyCustomerSourceAuthority("x".repeat(4 * 1024 * 1024 + 1)), false);
});

test("resolves a hardened proxy invoked by the exact Desk path route", () => {
  const desk = hostRoute("desk.manpengan.xyz", invoke("desk-upstream"));
  const value = withNamedRoutes(adapted(desk), {
    "desk-upstream": { handle: [reverseProxy()] },
  });
  assert.equal(hasCustomerSourceAuthority(value), true);
});

test("rejects a real-adapter-shaped unsafe named route before a later safe route", () => {
  const unsafe = reverseProxy({ set: { Host: ["127.0.0.1:8787"] }, delete: [] });
  const desk = prependDeskRoute(hostRoute("desk.manpengan.xyz"), {
    handle: [invoke("unsafe")],
  });
  const value = withNamedRoutes(adapted(desk), { unsafe: { handle: [unsafe] } });
  assert.equal(hasCustomerSourceAuthority(value), false);
});

test("rejects nested unsafe, missing and cyclic named route invocations", () => {
  const invokedDesk = prependDeskRoute(hostRoute("desk.manpengan.xyz"), {
    handle: [invoke("outer")],
  });
  const unsafe = reverseProxy({ set: { Host: ["127.0.0.1:8787"] }, delete: [] });
  const candidates = [
    { outer: { handle: [invoke("inner")] }, inner: { handle: [unsafe] } },
    { outer: { handle: [invoke("missing")] } },
    { outer: { handle: [invoke("inner")] }, inner: { handle: [invoke("outer")] } },
  ];
  for (const namedRoutes of candidates) {
    assert.equal(
      hasCustomerSourceAuthority(withNamedRoutes(adapted(invokedDesk), namedRoutes)),
      false,
    );
  }
});

test("rejects named route depth and count bounds", () => {
  const invokedDesk = prependDeskRoute(hostRoute("desk.manpengan.xyz"), {
    handle: [invoke("route-0")],
  });
  const deepRoutes = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      `route-${index}`,
      { handle: index === 16 ? [{ handler: "headers" }] : [invoke(`route-${index + 1}`)] },
    ]),
  );
  assert.equal(
    hasCustomerSourceAuthority(withNamedRoutes(adapted(invokedDesk), deepRoutes)),
    false,
  );

  const tooManyRoutes = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => [`unused-${index}`, { handle: [] }]),
  );
  assert.equal(hasCustomerSourceAuthority(withNamedRoutes(adapted(), tooManyRoutes)), false);
});

test("allows known continuing headers and disjoint static matcher routes", () => {
  const desk = prependDeskRoute(
    prependDeskRoute(hostRoute("desk.manpengan.xyz"), {
      match: [{ path: ["/assets/*"] }],
      handle: [{ handler: "file_server" }],
    }),
    { handle: [{ handler: "headers" }] },
  );
  assert.equal(hasCustomerSourceAuthority(adapted(desk)), true);
});
