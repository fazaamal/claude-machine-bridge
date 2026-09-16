import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// CMB_CONFIG_DIR lets a second instance run alongside the first (testing, or
// two bridges with different scopes on one host).
export const CONFIG_DIR =
  process.env.CMB_CONFIG_DIR ||
  path.join(os.homedir(), ".config", "claude-machine-bridge");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  port: 8791,
  // Read/write of files is restricted to these roots. Anything outside is refused
  // even though the tailnet is already a trust boundary - a compromised or
  // mistaken peer should not be able to walk the whole disk.
  allowedRoots: [
    path.join(os.homedir(), "Projects"),
    path.join(os.homedir(), "Downloads", "claude-inbox"),
  ],
  // `ask` runs headless Claude on this machine. Off by default: it is the one
  // capability that executes rather than reads.
  allowAsk: true,
  askTimeoutMs: 180000,
  maxFileBytes: 25 * 1024 * 1024,
  // Extra targets that tailnet discovery won't surface: a second local
  // instance, a host reached by plain IP, or a non-default port.
  // [{ name: "laptop-b", url: "http://127.0.0.1:8792" }]
  staticPeers: [],
};

export function loadConfig() {
  let cfg = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    cfg = { ...cfg, ...raw };
  } catch {
    /* first run - defaults apply until `install` writes the file */
  }
  if (!cfg.token) cfg.token = process.env.CMB_TOKEN || "";
  return cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return CONFIG_PATH;
}

export function ensureConfig() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    cfg = { ...DEFAULTS, token: crypto.randomBytes(32).toString("hex") };
    saveConfig(cfg);
  }
  return { ...DEFAULTS, ...cfg };
}

/** Resolve a caller-supplied path, refusing anything outside allowedRoots. */
export function resolveAllowed(p, cfg, { forWrite = false } = {}) {
  if (!p || typeof p !== "string") throw new Error("path required");
  const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  const abs = path.resolve(expanded);
  const real = (() => {
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs; // may not exist yet on write
    }
  })();
  const ok = cfg.allowedRoots.some((root) => {
    const r = path.resolve(root);
    return real === r || real.startsWith(r + path.sep);
  });
  if (!ok) {
    throw new Error(
      `path outside allowed roots: ${abs}\nallowed: ${cfg.allowedRoots.join(", ")}`
    );
  }
  if (forWrite) fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}
