import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createElectronDesktopDependencies,
  DESKTOP_MAX_RESPONSE_BYTES,
  type ElectronCookieSurface,
  type ElectronNetRequestOptions,
} from "./electron-adapter.js";
import {
  DESKTOP_API_BASE_URL,
  DESKTOP_REQUEST_ORIGIN,
  type DesktopHttpRequest,
} from "./http-transport.js";

class MockResponse extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly chunks: readonly Buffer[],
    readonly headers: Readonly<
      Record<string, string | readonly string[] | undefined>
    > = Object.freeze({ "content-type": "application/json" }),
  ) {
    super();
  }
}

class MockRequest extends EventEmitter {
  readonly writes: Array<string | Uint8Array> = [];
  aborted = false;

  constructor(private readonly response: MockResponse) {
    super();
  }

  write(body: string | Uint8Array): void {
    this.writes.push(body);
  }

  end(): void {
    queueMicrotask(() => {
      this.emit("response", this.response);
      this.response.chunks.forEach((chunk) => this.response.emit("data", chunk));
      this.response.emit("end");
    });
  }

  abort(): void {
    this.aborted = true;
  }
}

const VALID_REQUEST: DesktopHttpRequest = Object.freeze({
  method: "POST",
  url: `${DESKTOP_API_BASE_URL}/api/v2/auth/login`,
  headers: Object.freeze({
    Origin: DESKTOP_REQUEST_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
  }),
  credentials: "include",
  redirect: "error",
  origin: DESKTOP_REQUEST_ORIGIN,
  body: '{"login":true}',
});

function createSession(cookies: readonly ElectronCookieSurface[] = []) {
  let removals: readonly Readonly<{ url: string; name: string }>[] = [];
  let flushes = 0;
  const session = Object.freeze({
    cookies: Object.freeze({
      async get(): Promise<readonly ElectronCookieSurface[]> {
        return cookies;
      },
      async remove(url: string, name: string): Promise<void> {
        removals = Object.freeze([...removals, Object.freeze({ url, name })]);
      },
      async flushStore(): Promise<void> {
        flushes += 1;
      },
    }),
  });
  return Object.freeze({
    session,
    get removals(): readonly Readonly<{ url: string; name: string }>[] {
      return removals;
    },
    get flushes(): number {
      return flushes;
    },
  });
}

test("Electron request pins the dedicated session and all fixed network controls", async () => {
  const sessionHarness = createSession();
  const response = new MockResponse(200, [Buffer.from('{"ok":'), Buffer.from("true}")]);
  const clientRequest = new MockRequest(response);
  let options: ElectronNetRequestOptions | undefined;
  const dependencies = createElectronDesktopDependencies({
    net: {
      request(nextOptions) {
        options = nextOptions;
        return clientRequest;
      },
    },
    session: sessionHarness.session,
    deviceId: "00000000-0000-4000-8000-000000000001",
  });

  const result = await dependencies.request(VALID_REQUEST);

  assert.deepEqual(result, { statusCode: 200, bodyText: '{"ok":true}' });
  assert.deepEqual(clientRequest.writes, [VALID_REQUEST.body]);
  assert.equal(options?.session, sessionHarness.session);
  assert.equal(options?.credentials, "include");
  assert.equal(options?.redirect, "error");
  assert.equal(options?.origin, DESKTOP_REQUEST_ORIGIN);
  assert.equal(options?.url, VALID_REQUEST.url);
  assert.deepEqual(options?.headers, VALID_REQUEST.headers);
});

test("Electron adapter rejects drifted transport controls before opening a socket", async () => {
  const sessionHarness = createSession();
  let requests = 0;
  const dependencies = createElectronDesktopDependencies({
    net: {
      request() {
        requests += 1;
        return new MockRequest(new MockResponse(200, []));
      },
    },
    session: sessionHarness.session,
    deviceId: "00000000-0000-4000-8000-000000000001",
  });

  await assert.rejects(
    () =>
      dependencies.request({
        ...VALID_REQUEST,
        url: "https://attacker.invalid/",
        headers: {
          ...VALID_REQUEST.headers,
          "X-Forwarded-Host": "attacker.invalid",
        },
      }),
    /fixed desktop HTTP policy/u,
  );
  assert.equal(requests, 0);
});

test("Electron adapter permits raw photo bytes only on the fixed validated upload route", async () => {
  const sessionHarness = createSession();
  const response = new MockResponse(200, [Buffer.from('{"ok":true}')]);
  const clientRequest = new MockRequest(response);
  const dependencies = createElectronDesktopDependencies({
    net: { request: () => clientRequest },
    session: sessionHarness.session,
    deviceId: "00000000-0000-4000-8000-000000000001",
  });
  const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
  const photoRequest: DesktopHttpRequest = Object.freeze({
    ...VALID_REQUEST,
    url:
      `${DESKTOP_API_BASE_URL}/api/v2/photos?` +
      "upload_id=dddddddd-dddd-4ddd-8ddd-dddddddddddd&" +
      "order_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&" +
      "garment_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&kind=receive",
    headers: Object.freeze({
      ...VALID_REQUEST.headers,
      "Content-Type": "image/jpeg",
      Authorization: "Bearer token",
      "X-CSRF-Token": "csrf",
    }),
    body: bytes,
  });

  await dependencies.request(photoRequest);
  assert.deepEqual(clientRequest.writes, [bytes]);
  await assert.rejects(
    () =>
      dependencies.request({
        ...photoRequest,
        url: `${DESKTOP_API_BASE_URL}/api/v2/auth/login`,
      }),
    /fixed desktop HTTP policy/u,
  );
});

test("Electron adapter reads bounded photo bytes only from the named download route", async () => {
  const sessionHarness = createSession();
  const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46]);
  const clientRequest = new MockRequest(
    new MockResponse(200, [bytes], Object.freeze({ "content-type": "image/webp" })),
  );
  const dependencies = createElectronDesktopDependencies({
    net: { request: () => clientRequest },
    session: sessionHarness.session,
    deviceId: "00000000-0000-4000-8000-000000000001",
  });
  const request: DesktopHttpRequest = Object.freeze({
    method: "GET",
    url:
      `${DESKTOP_API_BASE_URL}/api/v2/photos/` + "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/thumbnail",
    headers: Object.freeze({
      Origin: DESKTOP_REQUEST_ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      Authorization: "Bearer token",
    }),
    credentials: "include",
    redirect: "error",
    origin: DESKTOP_REQUEST_ORIGIN,
  });

  assert.deepEqual(await dependencies.photoRequest?.(request), {
    statusCode: 200,
    contentType: "image/webp",
    bodyBytes: Uint8Array.from(bytes),
  });
  assert.deepEqual(clientRequest.writes, []);
});

test("Electron adapter rejects the app scheme as an HTTP request initiator", async () => {
  const sessionHarness = createSession();
  let requests = 0;
  const dependencies = createElectronDesktopDependencies({
    net: {
      request() {
        requests += 1;
        return new MockRequest(new MockResponse(200, []));
      },
    },
    session: sessionHarness.session,
    deviceId: "00000000-0000-4000-8000-000000000001",
  });

  await assert.rejects(
    () =>
      dependencies.request({
        ...VALID_REQUEST,
        headers: {
          ...VALID_REQUEST.headers,
          Origin: "app://local",
          "Sec-Fetch-Site": "none",
        },
        origin: "app://local" as typeof DESKTOP_REQUEST_ORIGIN,
      }),
    /fixed desktop HTTP policy/u,
  );
  assert.equal(requests, 0);
});

test("Electron adapter bounds response bytes and aborts an oversized response", async () => {
  const sessionHarness = createSession();
  const response = new MockResponse(200, [Buffer.alloc(DESKTOP_MAX_RESPONSE_BYTES + 1)]);
  const clientRequest = new MockRequest(response);
  const dependencies = createElectronDesktopDependencies({
    net: { request: () => clientRequest },
    session: sessionHarness.session,
    deviceId: "00000000-0000-4000-8000-000000000001",
  });

  await assert.rejects(() => dependencies.request(VALID_REQUEST), /response is too large/u);
  assert.equal(clientRequest.aborted, true);
});

test("cookie adapter exposes only CSRF candidates and clears all local auth cookies", async () => {
  const sessionHarness = createSession([
    {
      name: "laundry_csrf",
      value: "local-csrf",
      secure: false,
      domain: "127.0.0.1",
      path: "/",
    },
    {
      name: "__Host-laundry_csrf",
      value: "secure-csrf",
      secure: true,
      domain: "127.0.0.1",
      path: "/",
    },
    {
      name: "laundry_refresh",
      value: "refresh-secret",
      secure: false,
      domain: "127.0.0.1",
      path: "/",
    },
    {
      name: "unrelated",
      value: "keep",
      secure: false,
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const dependencies = createElectronDesktopDependencies({
    net: {
      request: () => new MockRequest(new MockResponse(200, [])),
    },
    session: sessionHarness.session,
    deviceId: "00000000-0000-4000-8000-000000000001",
  });

  assert.deepEqual(await dependencies.cookies.get(DESKTOP_API_BASE_URL), [
    { name: "laundry_csrf", value: "local-csrf" },
    { name: "__Host-laundry_csrf", value: "secure-csrf" },
  ]);
  await dependencies.cookies.clear(DESKTOP_API_BASE_URL);

  assert.deepEqual(sessionHarness.removals.map((removal) => removal.name).sort(), [
    "__Host-laundry_csrf",
    "laundry_csrf",
    "laundry_refresh",
  ]);
  assert.equal(
    sessionHarness.removals.some((removal) => removal.name === "unrelated"),
    false,
  );
  assert.equal(sessionHarness.flushes, 1);
});
