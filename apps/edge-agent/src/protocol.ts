import { existsSync, readFileSync } from "node:fs";
import { mimeFor } from "./lib/mime.js";
import { resolveSpaPath } from "./lib/spa-path.js";

/** Register app:// handler that serves files from the built-in SPA root only. */
export function createAppProtocolHandler(spaRoot: string) {
  return (request: Request): Response => {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const filePath = resolveSpaPath(spaRoot, pathname);
    if (!filePath || !existsSync(filePath)) {
      return new Response("not found", { status: 404 });
    }

    const body = readFileSync(filePath);
    return new Response(body, {
      headers: { "content-type": mimeFor(filePath) },
    });
  };
}
