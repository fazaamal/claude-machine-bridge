/** Loopback HTTP daemon. Tailscale Serve fronts it; every route needs the token. */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ensureConfig, resolveAllowed } from "./config.js";
import { listSessions, readContext, searchTranscripts } from "./claude-data.js";

const cfg = ensureConfig();

function send(res, code, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body, null, 2) : body;
  res.writeHead(code, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

/** Constant-time compare so a wrong token can't be probed byte by byte. */
function tokenOk(req) {
  const given = (req.headers["x-cmb-token"] || "").toString();
  const want = cfg.token || "";
  if (!want || given.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > cap) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function runAsk(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const bin = process.env.CMB_CLAUDE_BIN || "claude";
    const child = spawn(bin, ["-p", prompt], {
      cwd: cwd || os.homedir(),
      env: { ...process.env, PATH: `${os.homedir()}/.nvm/versions/node/v24.13.1/bin:${process.env.PATH}` },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ask timed out after ${cfg.askTimeoutMs}ms`));
    }, cfg.askTimeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `claude exited ${code}`));
    });
  });
}

export function startDaemon({ port = cfg.port } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname.replace(/\/+$/, "") || "/";

    if (p === "/health") {
      return send(res, 200, {
        ok: true,
        host: os.hostname(),
        version: "0.1.0",
        capabilities: { search: true, context: true, files: true, ask: !!cfg.allowAsk },
      });
    }

    if (!tokenOk(req)) return send(res, 401, { error: "bad or missing X-CMB-Token" });

    try {
      if (p === "/sessions") {
        return send(res, 200, {
          host: os.hostname(),
          sessions: listSessions({ limit: Number(url.searchParams.get("limit")) || 50 }),
        });
      }

      if (p === "/search") {
        const hits = await searchTranscripts(url.searchParams.get("q"), {
          limit: Number(url.searchParams.get("limit")) || 20,
        });
        return send(res, 200, { host: os.hostname(), query: url.searchParams.get("q"), hits });
      }

      if (p === "/context") {
        const ctx = await readContext(url.searchParams.get("session"), {
          limit: Number(url.searchParams.get("limit")) || 100,
        });
        return send(res, 200, { host: os.hostname(), ...ctx });
      }

      if (p === "/file" && req.method === "GET") {
        const abs = resolveAllowed(url.searchParams.get("path"), cfg);
        const st = fs.statSync(abs);
        if (st.size > cfg.maxFileBytes) throw new Error(`file too large (${st.size} bytes)`);
        return send(res, 200, {
          host: os.hostname(),
          path: abs,
          sizeBytes: st.size,
          base64: fs.readFileSync(abs).toString("base64"),
        });
      }

      if (p === "/file" && req.method === "PUT") {
        const raw = await readBody(req, cfg.maxFileBytes * 1.4);
        const { path: dest, base64 } = JSON.parse(raw.toString("utf8"));
        const abs = resolveAllowed(dest, cfg, { forWrite: true });
        const buf = Buffer.from(base64, "base64");
        fs.writeFileSync(abs, buf);
        return send(res, 200, { host: os.hostname(), path: abs, sizeBytes: buf.length });
      }

      if (p === "/ls") {
        const abs = resolveAllowed(url.searchParams.get("path"), cfg);
        const entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({
          name: e.name,
          dir: e.isDirectory(),
        }));
        return send(res, 200, { host: os.hostname(), path: abs, entries });
      }

      if (p === "/ask" && req.method === "POST") {
        if (!cfg.allowAsk) return send(res, 403, { error: "ask is disabled on this machine" });
        const { prompt, cwd } = JSON.parse((await readBody(req, 1e6)).toString("utf8"));
        const answer = await runAsk(prompt, cwd);
        return send(res, 200, { host: os.hostname(), answer });
      }

      return send(res, 404, { error: `no route ${p}` });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`claude-machine-bridge daemon on http://127.0.0.1:${port}`);
    console.log(`allowed roots: ${cfg.allowedRoots.join(", ")}`);
    console.log(`ask enabled: ${!!cfg.allowAsk}`);
  });
  return server;
}
