#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { ensureConfig, loadConfig, saveConfig, CONFIG_PATH } from "./config.js";
import { discover } from "./peers.js";

const [, , cmd, ...rest] = process.argv;
const arg = (flag) => {
  const i = rest.indexOf(flag);
  return i === -1 ? undefined : rest[i + 1];
};

const LABEL = "com.user.claude-machine-bridge";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function plistBody(entry) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${entry}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${path.join(os.homedir(), ".config", "claude-machine-bridge", "daemon.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), ".config", "claude-machine-bridge", "daemon.err.log")}</string>
</dict>
</plist>
`;
}

function installLaunchAgent(entry) {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plistBody(entry));
  const uid = process.getuid();
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
  } catch {
    /* not loaded yet */
  }
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST]);
  execFileSync("launchctl", ["enable", `gui/${uid}/${LABEL}`]);
  return PLIST;
}

function mcpSnippet(entry) {
  return {
    "claude-machine-bridge": {
      command: process.execPath,
      args: [entry, "mcp"],
    },
  };
}

async function main() {
  const entry = path.resolve(new URL(import.meta.url).pathname);

  switch (cmd) {
    case "install": {
      const cfg = ensureConfig();
      const token = arg("--token");
      if (token) {
        cfg.token = token;
        saveConfig(cfg);
      }
      const plist = installLaunchAgent(entry);
      console.log("claude-machine-bridge installed\n");
      console.log(`  config      ${CONFIG_PATH}`);
      console.log(`  launchagent ${plist}`);
      console.log(`  port        ${cfg.port} (loopback)`);
      console.log(`  roots       ${cfg.allowedRoots.join(", ")}`);
      console.log(`  ask         ${cfg.allowAsk ? "enabled" : "disabled"}`);
      console.log(`\n  TOKEN (same on every machine):\n\n    ${cfg.token}\n`);
      console.log("The daemon binds loopback + your Tailscale address directly,");
      console.log("so no `tailscale serve` is needed. It is not exposed on your LAN.\n");
      console.log("Next:");
      console.log("  1. Register the MCP server with Claude Code:\n");
      console.log("     claude mcp add-json claude-machine-bridge '" +
        JSON.stringify(mcpSnippet(entry)["claude-machine-bridge"]) + "'\n");
      console.log("  2. On your OTHER machine, run the same install with --token <TOKEN above>");
      break;
    }

    case "serve": {
      const { startDaemon } = await import("./daemon.js");
      startDaemon({ port: Number(arg("--port")) || undefined });
      break;
    }

    case "mcp": {
      const { startMcp } = await import("./mcp.js");
      await startMcp();
      break;
    }

    case "status": {
      const cfg = loadConfig();
      console.log(`token configured: ${cfg.token ? "yes" : "NO - run install"}`);
      console.log(`port: ${cfg.port}\n`);
      const found = await discover();
      for (const m of found) {
        const tag = m.self ? " (this machine)" : "";
        const via = m.self ? "loopback" : (m.ips || [])[0] || m.dnsName;
        console.log(
          `${m.bridge ? "  OK  " : "  --  "}${m.host}${tag}  [${via}]  ${
            m.bridge ? `ask=${m.capabilities?.ask}` : m.reason || "no bridge"
          }`
        );
      }
      break;
    }

    case "doctor": {
      const cfg = loadConfig();
      const os2 = await import("node:os");
      const { execFileSync } = await import("node:child_process");
      const uid = process.getuid();
      console.log("claude-machine-bridge doctor\n");

      console.log(`config: ${CONFIG_PATH}`);
      console.log(`token:  ${cfg.token ? cfg.token.slice(0, 8) + "… (" + cfg.token.length + " chars)" : "MISSING"}`);
      console.log(`port:   ${cfg.port}\n`);

      let running = false;
      try {
        const out = execFileSync("launchctl", ["print", `gui/${uid}/${LABEL}`], { encoding: "utf8" });
        running = /state = running/.test(out);
        const pid = (out.match(/pid = (\d+)/) || [])[1];
        console.log(`launchd: ${running ? "running" : "NOT running"}${pid ? " (pid " + pid + ")" : ""}`);
      } catch {
        console.log("launchd: service not loaded  -> run `install`");
      }

      const tsAddrs = [];
      for (const list of Object.values(os2.networkInterfaces())) {
        for (const a of list || []) {
          if (a.internal) continue;
          if (a.family === "IPv4") {
            const [x, y] = a.address.split(".").map(Number);
            if (x === 100 && y >= 64 && y <= 127) tsAddrs.push(a.address);
          }
        }
      }
      console.log(`tailscale address: ${tsAddrs.length ? tsAddrs.join(", ") : "NONE (is Tailscale up?)"}`);

      const check = async (host) => {
        try {
          const r = await fetch(`http://${host}:${cfg.port}/health`, { signal: AbortSignal.timeout(4000) });
          return r.ok ? "OK" : `HTTP ${r.status}`;
        } catch (e) {
          return `unreachable (${String(e.message || e).slice(0, 40)})`;
        }
      };
      console.log(`  loopback  127.0.0.1:${cfg.port}  -> ${await check("127.0.0.1")}`);
      for (const a of tsAddrs) {
        const res = await check(a);
        console.log(`  tailnet   ${a}:${cfg.port}  -> ${res}`);
        if (res !== "OK") {
          console.log("\n  Bound to loopback only, or blocked. Try:");
          console.log(`    launchctl kickstart -k gui/${uid}/${LABEL}`);
          console.log("  If it still fails, macOS firewall may be blocking node:");
          console.log("    System Settings > Network > Firewall > Options > allow incoming for node");
        }
      }
      console.log("\nlog tail:");
      try {
        const log = fs.readFileSync(path.join(os.homedir(), ".config", "claude-machine-bridge", "daemon.log"), "utf8");
        console.log(log.trim().split("\n").slice(-6).map((l) => "  " + l).join("\n"));
      } catch {
        console.log("  (no daemon.log yet)");
      }
      break;
    }

    case "token": {
      const cfg = ensureConfig();
      if (rest[0] === "--rotate") {
        cfg.token = crypto.randomBytes(32).toString("hex");
        saveConfig(cfg);
        console.log("rotated. Set the same token on every machine:\n");
      }
      console.log(cfg.token);
      break;
    }

    case "uninstall": {
      const uid = process.getuid();
      try {
        execFileSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
      } catch {
        /* wasn't loaded */
      }
      fs.rmSync(PLIST, { force: true });
      console.log("launchagent removed. Config kept at " + CONFIG_PATH);
      break;
    }

    default:
      console.log(`claude-machine-bridge

  install [--token <shared>]   set up config + launchd daemon, print next steps
  serve   [--port N]           run the daemon in the foreground
  mcp                          run the MCP server on stdio (Claude Code uses this)
  status                       show which machines are reachable
  doctor                       diagnose why this machine is not reachable
  token   [--rotate]           print (or rotate) the shared token
  uninstall                    remove the launchd daemon

Works over the tailnet and over localhost - this machine is always reachable
on loopback, even with Tailscale stopped.`);
  }
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
