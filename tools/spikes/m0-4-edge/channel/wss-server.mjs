#!/usr/bin/env node
/**
 * Minimal WSS server on 127.0.0.1 for browser channel experiments.
 * Origin whitelist + per-message {nonce, seq, exp} anti-replay (spike-level).
 *
 * Usage:
 *   npm run cert && npm run wss
 *   open channel/browser-client.html in Chrome (may need cert trust first)
 */
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const dir = dirname(fileURLToPath(import.meta.url));
const certPath = join(dir, "certs/localhost-cert.pem");
const keyPath = join(dir, "certs/localhost-key.pem");
const PORT = Number(process.env.M0_4_PORT || 17443);
const USE_TLS = process.env.M0_4_WS !== "1";

const ALLOWED_ORIGINS = new Set([
  "https://127.0.0.1:17443",
  "http://127.0.0.1:17443",
  "https://localhost:17443",
  "http://localhost:17443",
  "null", // file:// pages
  "app://local",
  "app://-",
]);

const seenNonces = new Map(); // nonce -> exp
const MAX_SKEW_MS = 30_000;

function pruneNonces(now) {
  for (const [n, exp] of seenNonces) {
    if (exp < now) seenNonces.delete(n);
  }
}

function validateMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (typeof msg.nonce !== "string" || typeof msg.seq !== "number") {
    return { ok: false, error: "missing_nonce_or_seq" };
  }
  if (typeof msg.exp !== "number") {
    return { ok: false, error: "missing_exp" };
  }
  const now = Date.now();
  if (msg.exp < now - MAX_SKEW_MS) {
    return { ok: false, error: "expired" };
  }
  pruneNonces(now);
  if (seenNonces.has(msg.nonce)) {
    return { ok: false, error: "replay" };
  }
  seenNonces.set(msg.nonce, msg.exp);
  return { ok: true, msg };
}

function buildServer() {
  if (!USE_TLS) {
    console.log("mode=ws (cleartext) port=%s", PORT);
    return createHttpServer((req, res) => {
      if (req.url === "/" || req.url === "/client") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(dir, "browser-client.html")));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
  }

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    console.error("missing certs — run: npm run cert");
    process.exit(1);
  }

  const key = readFileSync(keyPath, "utf8");
  if (key.includes("PLACEHOLDER") || !key.includes("PRIVATE KEY")) {
    console.error("cert is placeholder; install openssl and re-run npm run cert");
    process.exit(1);
  }

  console.log("mode=wss port=%s", PORT);
  return createHttpsServer(
    {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    },
    (req, res) => {
      if (req.url === "/" || req.url === "/client") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(dir, "browser-client.html")));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("m0-4 wss ok\n");
    },
  );
}

const server = buildServer();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin ?? "null";
  if (!ALLOWED_ORIGINS.has(origin) && !String(origin).startsWith("app://")) {
    console.warn("reject origin", origin);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin ?? "null";
  console.log("connected origin=%s", origin);
  ws.send(
    JSON.stringify({
      type: "hello",
      channel: USE_TLS ? "wss" : "ws",
      ts: Date.now(),
    }),
  );
  ws.on("message", (data) => {
    const result = validateMessage(data);
    if (!result.ok) {
      ws.send(JSON.stringify({ type: "error", error: result.error }));
      return;
    }
    ws.send(
      JSON.stringify({
        type: "ack",
        seq: result.msg.seq,
        echo: result.msg.payload ?? null,
        at: Date.now(),
      }),
    );
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const scheme = USE_TLS ? "https" : "http";
  const wsScheme = USE_TLS ? "wss" : "ws";
  console.log("listen %s://127.0.0.1:%s", scheme, PORT);
  console.log("ws    %s://127.0.0.1:%s", wsScheme, PORT);
  console.log("client %s://127.0.0.1:%s/client", scheme, PORT);
});
