/** Read this machine's local Claude Code state: sessions, transcripts, context. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const SESSIONS = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude-code-sessions"
);

/** Every transcript on this machine, newest first. */
export function listTranscripts() {
  const out = [];
  if (!fs.existsSync(PROJECTS)) return out;
  for (const project of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, project);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        out.push({
          sessionId: f.replace(/\.jsonl$/, ""),
          project: project.replace(/^-/, "/").replace(/-/g, "/"),
          projectKey: project,
          path: p,
          sizeBytes: st.size,
          modifiedAt: new Date(st.mtimeMs).toISOString(),
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Titles from the desktop app's session sidecars, keyed by cliSessionId. */
export function sessionTitles() {
  const map = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith("local_") && e.name.endsWith(".json")) {
        try {
          const d = JSON.parse(fs.readFileSync(p, "utf8"));
          if (d.cliSessionId) {
            map.set(d.cliSessionId, {
              title: d.title || null,
              cwd: d.cwd || null,
              appSessionId: d.sessionId || null,
              scheduledTaskId: d.scheduledTaskId || null,
            });
          }
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(SESSIONS);
  return map;
}

export function listSessions({ limit = 50 } = {}) {
  const titles = sessionTitles();
  return listTranscripts()
    .slice(0, limit)
    .map((t) => ({ ...t, ...(titles.get(t.sessionId) || {}) }));
}

const SKIP_TYPES = new Set([
  "attachment",
  "queue-operation",
  "last-prompt",
  "atis-latch",
  "file-history-snapshot",
  "custom-title",
]);

/** Pull readable events out of one transcript line. */
function eventsFromLine(d) {
  const out = [];
  if (SKIP_TYPES.has(d.type)) return out;
  const msg = d.message || {};
  const ts = d.timestamp || null;
  const clip = (s, n = 1500) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .slice(0, n);

  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "thinking" && b.thinking) out.push({ ts, kind: "thinking", text: clip(b.thinking) });
      else if (b.type === "text" && b.text) out.push({ ts, kind: "text", text: clip(b.text) });
      else if (b.type === "tool_use")
        out.push({ ts, kind: "tool", label: b.name, text: clip(JSON.stringify(b.input || {}), 300) });
    }
  } else if (msg.role === "user") {
    if ("toolUseResult" in d) {
      out.push({ ts, kind: "result", text: "(tool result)" });
    } else if (typeof msg.content === "string") {
      out.push({ ts, kind: "prompt", text: clip(msg.content) });
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && b.type === "text" && b.text) out.push({ ts, kind: "prompt", text: clip(b.text) });
      }
    }
  }
  return out;
}

export async function readContext(sessionId, { limit = 100 } = {}) {
  const hit = listTranscripts().find((t) => t.sessionId === sessionId);
  if (!hit) throw new Error(`no transcript for session ${sessionId} on this machine`);
  const events = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(hit.path),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(...eventsFromLine(d));
    if (events.length > limit * 6) events.splice(0, events.length - limit * 6);
  }
  const titles = sessionTitles();
  return {
    sessionId,
    ...(titles.get(sessionId) || {}),
    project: hit.project,
    sizeBytes: hit.sizeBytes,
    events: events.slice(-limit),
  };
}

/** Case-insensitive substring search over transcripts, one hit per session. */
export async function searchTranscripts(query, { limit = 20 } = {}) {
  const q = String(query || "").toLowerCase();
  if (q.length < 2) throw new Error("query must be at least 2 characters");
  const titles = sessionTitles();
  const hits = [];
  for (const t of listTranscripts()) {
    if (hits.length >= limit) break;
    let found = null;
    let matches = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(t.path),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const i = line.toLowerCase().indexOf(q);
      if (i === -1) continue;
      matches++;
      if (!found) {
        const start = Math.max(0, i - 90);
        found = line.slice(start, i + q.length + 90).replace(/\s+/g, " ");
      }
      if (matches > 25) break;
    }
    rl.close();
    if (found) {
      hits.push({
        sessionId: t.sessionId,
        ...(titles.get(t.sessionId) || {}),
        project: t.project,
        modifiedAt: t.modifiedAt,
        matches,
        snippet: found,
      });
    }
  }
  return hits;
}
