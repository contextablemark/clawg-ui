import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function resolvePluginRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const candidate = join(dir, "package.json");
      statSync(candidate);
      return dir;
    } catch {
      // keep climbing
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("clawpilotkit: could not locate plugin root (package.json not found)");
}

const PLUGIN_ROOT = resolvePluginRoot();
const UI_ROOT = resolve(PLUGIN_ROOT, "ui");

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function mimeType(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = path.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

const ROUTE_PREFIX = "/v1/clawpilotkit/ui";

function resolveRequestedFile(reqUrl: string): string | null {
  const url = new URL(reqUrl, "http://localhost");
  let relative = url.pathname;
  if (!relative.startsWith(ROUTE_PREFIX)) return null;
  relative = relative.slice(ROUTE_PREFIX.length);
  if (relative.startsWith("/")) relative = relative.slice(1);
  if (relative === "" || relative.endsWith("/")) {
    relative = `${relative}index.html`;
  }
  if (relative.includes("..")) return null;
  const normalized = normalize(relative).replace(/^(\.\.[/\\])+/, "");
  const absolute = resolve(UI_ROOT, normalized);
  if (!absolute.startsWith(UI_ROOT + "/") && absolute !== UI_ROOT) {
    return null;
  }
  return absolute;
}

export function createStaticUiHandler() {
  return function handleStaticUiRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean | Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.statusCode = 405;
      res.end();
      return true;
    }
    const requested = resolveRequestedFile(req.url ?? "/");
    if (!requested) {
      res.statusCode = 400;
      res.end();
      return true;
    }

    let stat;
    try {
      stat = statSync(requested);
    } catch {
      res.statusCode = 404;
      res.end();
      return true;
    }
    if (!stat.isFile()) {
      res.statusCode = 404;
      res.end();
      return true;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", mimeType(requested));
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "public, max-age=60");
    // Embedded slot consumers render this bundle inside a sandboxed iframe
    // without `allow-same-origin`, which gives the document an opaque "null"
    // origin. Module scripts loaded from that document require CORS headers
    // even for same-origin URLs. `*` is safe here — the assets are plain
    // UI shell with no credentials.
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(requested).pipe(res);
    return true;
  };
}
