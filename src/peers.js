/** Find tailnet peers and talk to the bridge daemon on them. */
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";

const pexec = promisify(execFile);
const TAILSCALE_CANDIDATES = [
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "tailscale",
];

async function tailscale(args) {
  let lastErr;
  for (const bin of TAILSCALE_CANDIDATES) {
    try {
      const { stdout } = await pexec(bin, args, { maxBuffer: 8e6 });
      return stdout;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`tailscale CLI not usable: ${lastErr?.message || "not found"}`);
}

const LOCAL_ALIASES = new Set(["localhost", "local", "self", "this", "127.0.0.1", "me"]);

/** This machine, always reachable over loopback even with Tailscale down. */
function selfEntry(extra = {}) {
  return {
    host: os.hostname().replace(/\.local$/, ""),
    dnsName: "localhost",
    ips: ["127.0.0.1"],
    online: true,
    os: process.platform,
    self: true,
    ...extra,
  };
}

/**
 * Every reachable target: this machine (always, via loopback) plus online
 * tailnet peers. Tailscale being absent or stopped degrades to localhost-only
 * rather than failing outright.
 */
export async function tailnetPeers() {
  let raw;
  try {
    raw = await tailscale(["status", "--json"]);
  } catch {
    return [selfEntry({ tailscale: false }), ...staticPeers()];
  }
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return [selfEntry({ tailscale: false }), ...staticPeers()];
  }
  const clean = (n) => String(n || "").replace(/\.$/, "");
  // Prefer the MagicDNS short name as the identifier: iOS devices all report
  // HostName "localhost", and macOS HostNames can carry spaces and apostrophes
  // ("Faza's Macbook Pro M1 Pro"), neither of which makes a usable handle.
  const shortName = (p) => {
    const dns = clean(p.DNSName).split(".")[0];
    const hn = clean(p.HostName);
    if (dns) return dns;
    return hn && hn.toLowerCase() !== "localhost" ? hn : "unknown";
  };
  const peers = Object.values(d.Peer || {}).map((p) => ({
    host: shortName(p),
    label: clean(p.HostName),
    dnsName: clean(p.DNSName),
    ips: p.TailscaleIPs || [],
    online: !!p.Online,
    os: p.OS,
    self: false,
    tailscale: true,
  }));
  // Self keeps its tailnet identity for display, but is still dialled on loopback.
  const self = selfEntry(
    d.Self
      ? {
          host: shortName(d.Self),
          label: clean(d.Self.HostName),
          tailnetName: clean(d.Self.DNSName),
          tailscale: true,
        }
      : { tailscale: false }
  );
  return [self, ...peers, ...staticPeers()];
}

/** Explicit targets from config, merged in alongside tailnet peers. */
function staticPeers() {
  const cfg = loadConfig();
  return (cfg.staticPeers || []).map((s) => ({
    host: s.name,
    label: s.name,
    dnsName: s.name,
    url: s.url,
    ips: [],
    online: true,
    os: "static",
    self: false,
    static: true,
  }));
}

/** Explicit url wins; loopback for this machine; tailnet address otherwise. */
function baseUrl(peer, port) {
  if (peer.url) return peer.url.replace(/\/+$/, "");
  if (peer.self) return `http://127.0.0.1:${port}`;
  const ip = (peer.ips || []).find((a) => a.includes(".")) || peer.dnsName;
  return `http://${ip}:${port}`;
}

async function call(peer, pathname, { method = "GET", body, timeoutMs = 20000 } = {}) {
  const cfg = loadConfig();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(peer, cfg.port)}${pathname}`, {
      method,
      signal: ctl.signal,
      headers: {
        "X-CMB-Token": cfg.token || "",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON reply (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Discovery cache. Probing every tailnet device on every call is slow — phones
 * and offline laptops each burn the full timeout — so results are cached and
 * refreshed in the background.
 */
const DISCOVERY_TTL_MS = 3 * 60 * 1000;
let cache = { at: 0, results: [], inflight: null };

async function probeAll() {
  const peers = await tailnetPeers();
  return Promise.all(
    peers
      .filter((p) => p.online)
      .map(async (p) => {
        try {
          const h = await call(p, "/health", { timeoutMs: p.self ? 2000 : 4000 });
          return { ...p, bridge: true, capabilities: h.capabilities, remoteHost: h.host };
        } catch (e) {
          return { ...p, bridge: false, reason: String(e.message || e).slice(0, 80) };
        }
      })
  );
}

/**
 * Machines on the tailnet. Only those actually running the bridge are returned
 * unless `all` is set — a phone with no daemon is noise, not a target.
 */
export async function discover({ includeSelf = true, all = false, force = false } = {}) {
  const fresh = Date.now() - cache.at < DISCOVERY_TTL_MS;
  if (force || !fresh) {
    // Collapse concurrent refreshes into one probe.
    if (!cache.inflight) {
      cache.inflight = probeAll()
        .then((results) => {
          cache = { at: Date.now(), results, inflight: null };
          return results;
        })
        .catch((e) => {
          cache.inflight = null;
          if (!cache.results.length) throw e;
          return cache.results; // serve stale rather than fail
        });
    }
    await cache.inflight;
  }
  return cache.results
    .filter((m) => (all ? true : m.bridge))
    .filter((m) => (includeSelf ? true : !m.self));
}

/** Refresh in the background on an interval; returns a stop function. */
export function startDiscoveryRefresh(intervalMs = DISCOVERY_TTL_MS) {
  discover({ force: true }).catch(() => {});
  const t = setInterval(() => {
    discover({ force: true }).catch(() => {});
  }, intervalMs);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

export const discoveryAge = () => (cache.at ? Date.now() - cache.at : null);

async function resolvePeer(name) {
  const peers = await tailnetPeers();
  const n = String(name || "").toLowerCase().replace(/\.$/, "");
  if (!n || LOCAL_ALIASES.has(n)) return peers.find((p) => p.self) || selfEntry();
  const hit =
    peers.find((p) => p.host.toLowerCase() === n) ||
    peers.find((p) => (p.dnsName || "").toLowerCase().startsWith(n + ".")) ||
    peers.find((p) => (p.tailnetName || "").toLowerCase().startsWith(n + ".")) ||
    peers.find((p) => p.host.toLowerCase().includes(n)) ||
    peers.find((p) => (p.ips || []).includes(name));
  if (!hit) {
    throw new Error(
      `unknown machine "${name}". Known: ${peers.map((p) => p.host).join(", ")} (or "localhost")`
    );
  }
  if (!hit.online && !hit.self) throw new Error(`machine "${hit.host}" is offline`);
  return hit;
}

export const remote = {
  async sessions(machine, limit = 50) {
    return call(await resolvePeer(machine), `/sessions?limit=${limit}`);
  },
  async search(machine, query, limit = 20) {
    return call(
      await resolvePeer(machine),
      `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      { timeoutMs: 60000 }
    );
  },
  async context(machine, sessionId, limit = 100) {
    return call(
      await resolvePeer(machine),
      `/context?session=${encodeURIComponent(sessionId)}&limit=${limit}`,
      { timeoutMs: 60000 }
    );
  },
  async getFile(machine, p) {
    return call(await resolvePeer(machine), `/file?path=${encodeURIComponent(p)}`, {
      timeoutMs: 120000,
    });
  },
  async putFile(machine, p, base64) {
    return call(await resolvePeer(machine), "/file", {
      method: "PUT",
      body: { path: p, base64 },
      timeoutMs: 120000,
    });
  },
  async ls(machine, p) {
    return call(await resolvePeer(machine), `/ls?path=${encodeURIComponent(p)}`);
  },
  async ask(machine, prompt, cwd) {
    return call(await resolvePeer(machine), "/ask", {
      method: "POST",
      body: { prompt, cwd },
      timeoutMs: 200000,
    });
  },
};

export const thisHost = () => os.hostname();
