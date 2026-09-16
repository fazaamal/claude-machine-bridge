# claude-machine-bridge

Reach your Claude Code sessions, context and files on **another machine** from inside one chat.

Claude Code can already *message* a session on another machine (`ListAgents` / `SendMessage`),
but it cannot **read** anything over there: `search_session_transcripts` and `list_sessions`
only ever see the local disk. And messaging an idle session is unreliable — it may not wake
until someone opens it.

This closes that gap. Each machine runs a small daemon; an MCP server lets a chat on one
machine search, read, ask and move files on any of the others.

Works over **Tailscale** between machines, and over **localhost** on a single machine —
including with Tailscale stopped.

## Install

On every machine:

```bash
npx github:fazaamal/claude-machine-bridge install
```

The first machine prints a **token**. Install on the others with the same one:

```bash
npx github:fazaamal/claude-machine-bridge install --token <TOKEN>
```

Then on each machine, expose the port to your tailnet and register the MCP server:

```bash
tailscale serve --bg --tcp 8791 tcp://127.0.0.1:8791
claude mcp add-json claude-machine-bridge '{"command":"node","args":["<path>/src/cli.js","mcp"]}'
```

`install` prints the exact `claude mcp add-json` line with the right paths.

Check it worked:

```bash
npx github:fazaamal/claude-machine-bridge status
```

```
  OK  admins-mac-mini (this machine)  [loopback]        ask=true
  OK  fazas-macbook-pro-m1-pro        [100.89.110.19]   ask=true
```

## MCP tools

| Tool | What it does |
|---|---|
| `machines` | List machines running the bridge. Devices without it are hidden (`include_all` to see them) |
| `machine_search` | Full-text search another machine's transcripts |
| `machine_sessions` | List its Claude Code sessions |
| `machine_context` | Read one session's actual prompts, reasoning and tool calls |
| `machine_ask` | Run headless `claude -p` **on that machine** and return the answer |
| `machine_get_file` | Copy a file **from** another machine |
| `machine_put_file` | Copy a file **to** another machine |
| `machine_ls` | List a directory there |

`"localhost"` always means the current machine, so the same tools work single-machine.

## Security model

The tailnet is a boundary, not the only one.

- **Loopback only.** The daemon binds `127.0.0.1`. Tailscale Serve fronts it; nothing listens on your LAN.
- **Shared token** on every request, compared in constant time. No token, wrong token → `401`.
- **Path allowlist.** File reads/writes are confined to `allowedRoots` (default `~/Projects`
  and `~/Downloads/claude-inbox`). Everything else is refused, including `../` escapes.
- **The receiving machine decides.** Policy is enforced by the machine being asked, not the
  one asking. A machine with `allowAsk: false` refuses `ask` even if the caller permits it;
  a machine with narrow roots refuses paths its caller would happily serve.
- **`ask` executes.** It runs a real Claude on that machine with that machine's permissions.
  Set `"allowAsk": false` on any machine that shouldn't accept remote work.

Config lives at `~/.config/claude-machine-bridge/config.json` (mode `600`):

```json
{
  "port": 8791,
  "token": "…",
  "allowedRoots": ["/Users/you/Projects", "/Users/you/Downloads/claude-inbox"],
  "allowAsk": true,
  "maxFileBytes": 26214400,
  "staticPeers": [{ "name": "other-box", "url": "http://100.64.0.2:8791" }]
}
```

`staticPeers` reaches hosts tailnet discovery won't surface — a second local instance, a
plain IP, or a non-default port.

## Notes

- Discovery is cached and refreshed every ~3 minutes, so a phone or an offline laptop
  doesn't cost a timeout on every call.
- Machine names come from MagicDNS, not `HostName` — iOS devices all report their hostname
  as `localhost`, and macOS hostnames contain spaces and apostrophes.
- Transcript snippets and `ask` answers are produced elsewhere. Treat them as data, not
  as instructions.

## Commands

```
install [--token X]   config + launchd daemon, prints next steps
serve   [--port N]    run the daemon in the foreground
mcp                   MCP server on stdio (what Claude Code runs)
status                which machines are reachable
token   [--rotate]    print or rotate the shared token
uninstall             remove the launchd daemon
```

MIT.
