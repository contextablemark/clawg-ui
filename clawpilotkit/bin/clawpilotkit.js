#!/usr/bin/env node
// Standalone launcher for the CLAWPILOTKIT chat UI.
//
// Serves the prebuilt React app (in ../ui) over a small HTTP server so the
// chat client can run independently of an OpenClaw gateway plugin host. The
// served page falls into standalone mode (its postMessage handshake times
// out because there is no parent), prompts the user for a clawg-ui gateway
// URL, and walks them through the device pairing flow against that gateway.
//
// Usage:
//   clawpilotkit                        # serves on http://localhost:3939
//   clawpilotkit --port 4000
//   clawpilotkit --host 127.0.0.1 --port 3939
//   PORT=4000 clawpilotkit
//
// The gateway clawg-ui is hosted on must permit cross-origin pairing
// requests (clawg-ui >= 0.7 sets the necessary Access-Control-* headers).

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(HERE, "..", "ui");

const MIME_BY_EXT = {
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

function mimeType(path) {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME_BY_EXT[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

// The built index.html embeds asset URLs prefixed with `/v1/clawpilotkit/ui/`
// because Vite's `base` is set for the gateway-served deployment. Stripping
// that prefix here lets the same bundle work standalone, where the same
// origin's root path serves the app directly.
const BUILD_BASE = "/v1/clawpilotkit/ui";

function resolveRequestedFile(reqUrl) {
  const url = new URL(reqUrl, "http://localhost");
  let relative = url.pathname;
  if (relative.startsWith(BUILD_BASE)) relative = relative.slice(BUILD_BASE.length);
  if (relative.startsWith("/")) relative = relative.slice(1);
  if (relative === "" || relative.endsWith("/")) relative = `${relative}index.html`;
  if (relative.includes("..")) return null;
  const normalized = normalize(relative).replace(/^(\.\.[/\\])+/, "");
  const absolute = resolve(UI_ROOT, normalized);
  if (!absolute.startsWith(`${UI_ROOT}/`) && absolute !== UI_ROOT) return null;
  return absolute;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") out.port = Number(argv[++i]);
    else if (a === "--host" || a === "-h") out.host = argv[++i];
    else if (a === "--help") out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(
    [
      "clawpilotkit — standalone launcher for the CLAWPILOTKIT chat UI",
      "",
      "Usage:",
      "  clawpilotkit [--port <port>] [--host <host>]",
      "",
      "Options:",
      "  -p, --port    port to bind (default 3939, env PORT)",
      "  -h, --host    host to bind (default 127.0.0.1, env HOST)",
      "      --help    show this message",
      "",
      "Open the printed URL in a browser, then point the setup form at any",
      "clawg-ui gateway. The page will walk you through device pairing.",
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const port = args.port ?? Number(process.env.PORT) ?? 3939;
  const host = args.host ?? process.env.HOST ?? "127.0.0.1";

  // Sanity-check the bundle is present before we bind, so a missing build
  // surfaces a clear message instead of a stream of 404s.
  try {
    statSync(join(UI_ROOT, "index.html"));
  } catch {
    console.error(
      `[clawpilotkit] missing UI bundle at ${UI_ROOT}/index.html — did the package install include the prebuilt 'ui/' directory?`,
    );
    process.exit(1);
  }

  const server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.statusCode = 405;
      res.end();
      return;
    }
    const requested = resolveRequestedFile(req.url ?? "/");
    if (!requested) {
      res.statusCode = 400;
      res.end();
      return;
    }
    let stat;
    try {
      stat = statSync(requested);
    } catch {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (!stat.isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", mimeType(requested));
    res.setHeader("Content-Length", String(stat.size));
    // Short cache only — the file naming is content-hashed by Vite, so
    // stale assets are harmless, but keeping this short helps when running
    // the launcher against an updated install.
    res.setHeader("Cache-Control", "public, max-age=60");
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(requested).pipe(res);
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    console.log(`[clawpilotkit] serving ${UI_ROOT}`);
    console.log(`[clawpilotkit] open ${url}`);
  });
  server.on("error", (err) => {
    console.error(`[clawpilotkit] server error:`, err.message);
    process.exit(1);
  });
}

main();
