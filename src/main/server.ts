import http from "http";
import fs from "fs";
import { extname, join, normalize } from "path";
import { registerAllChannels } from "./ipc/registerAll";
import { invokeChannel } from "./ipc/helpers";
import { migrate } from "./db/migrate";
import { getSqlite } from "./db";
import { SettingsService } from "./services/settingsService";
import { PhotoService } from "./services/photoService";

const HOST = process.env.LAUNDRY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.LAUNDRY_PORT ?? 8620);
const RENDERER_DIR = join(__dirname, "../renderer");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}
async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 25 * 1024 * 1024) throw new Error("请求体过大");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {};
}
function safeRel(raw: string): string {
  return normalize(decodeURIComponent(raw)).replace(/^(\.\.(\/|\\|$))+/, "");
}
function streamFile(fp: string, res: http.ServerResponse): void {
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404).end("not found"); return; }
  res.writeHead(200, { "content-type": MIME[extname(fp).toLowerCase()] ?? "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
}
async function handleInvoke(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = (await readBody(req)) as { channel?: string; payload?: unknown };
    if (!body || typeof body.channel !== "string") {
      sendJson(res, 400, { ok: false, error: { code: "VALIDATION_FAILED", message: "缺少 channel" } });
      return;
    }
    sendJson(res, 200, await invokeChannel(body.channel, body.payload));
  } catch (e) {
    sendJson(res, 200, { ok: false, error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : "服务端错误" } });
  }
}

async function bootstrap(): Promise<void> {
  migrate(getSqlite());
  await SettingsService.initDefaults();
  registerAllChannels();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
    const path = url.pathname;
    if (path === "/api/invoke" && req.method === "POST") { void handleInvoke(req, res); return; }
    if (path === "/api/health") { sendJson(res, 200, { ok: true, data: "ok" }); return; }
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    if (path.startsWith("/media/")) { streamFile(PhotoService.getPhotoPath(safeRel(path.slice(7))), res); return; }
    const rel = path === "/" ? "index.html" : safeRel(path.slice(1));
    const fp = join(RENDERER_DIR, rel);
    if (fp.startsWith(RENDERER_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) { streamFile(fp, res); return; }
    streamFile(join(RENDERER_DIR, "index.html"), res);
  });
  server.listen(PORT, HOST, () => {
    console.log(`\n  宏发洗衣店 web server → http://${HOST}:${PORT}\n`);
  });
}
void bootstrap();
