# 📡 claude-intercom

**Real-time messaging between Claude Code instances.** When one agent sends a message, the others get it instantly — no polling, no manual checks.

Built as an [MCP server](https://modelcontextprotocol.io) + filesystem watcher that wakes idle agents automatically via `asyncRewake`.

## How it works

```
Terminal 1                          Terminal 2
┌─────────────────────┐            ┌─────────────────────┐
│ claude (agent sgup)  │            │ claude (agent 4jov)  │
│                      │            │                      │
│ > send("4jov",       │ ──JSON──▶ │ 📬 sgup: tu touches  │
│   "tu touches        │   file    │    auth.ts ?          │
│    auth.ts ?")       │            │                      │
│                      │ ◀──JSON── │ > reply("Non,        │
│ 📬 4jov: Non,        │   file    │   je suis sur        │
│   je suis sur billing│            │   billing")          │
└─────────────────────┘            └─────────────────────┘
```

- Each instance gets a **unique 4-char code** (e.g. `x7k2`) on startup
- Messages are JSON files in a shared `store/` directory
- A `fs.watch` watcher detects new files **instantly** and wakes the receiving agent
- Dead agents are auto-cleaned via PID checking

## Install

```bash
# Clone
git clone https://github.com/sanztheo/claude-intercom.git ~/.claude/mcp-intercom

# Install deps
cd ~/.claude/mcp-intercom && bun install
```

### 1. Register the MCP server

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "intercom": {
      "type": "stdio",
      "command": "bun",
      "args": ["~/.claude/mcp-intercom/src/server.ts"]
    }
  }
}
```

### 2. Add the auto-notification hooks

Add to `~/.claude/settings.json` under `"hooks"`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun ~/.claude/mcp-intercom/src/hook.ts",
            "timeout": 3000
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun ~/.claude/mcp-intercom/src/watcher.ts",
            "asyncRewake": true,
            "timeout": 300000
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun ~/.claude/mcp-intercom/src/watcher.ts",
            "asyncRewake": true,
            "timeout": 300000
          }
        ]
      }
    ]
  }
}
```

### 3. (Optional) Add the skill

Copy `skill/SKILL.md` to `~/.claude/skills/intercom/SKILL.md` so agents proactively coordinate.

## MCP Tools

| Tool | Description |
|------|-------------|
| `who` | List active agents (filtered by project by default) |
| `send` | Send a message to an agent or broadcast to `"all"` |
| `reply` | Reply to a message (auto-acks the original) |
| `peek` | Check inbox for unread messages |
| `ack` | Acknowledge and delete a message |
| `ack_all` | Clear entire inbox |

## Auto-notification

Three layers ensure agents never miss a message:

| Layer | When | How |
|-------|------|-----|
| **Watcher** (`SessionStart` + `Stop`) | Agent is idle | `fs.watch` on inbox dir → `exit(2)` → `asyncRewake` wakes the model |
| **Hook** (`PreToolUse`) | Agent is working | Checks inbox before every tool call |
| **Skill** (always active) | Agent makes decisions | Guides agent to announce work and check messages |

## Architecture

```
~/.claude/mcp-intercom/
├── src/
│   ├── server.ts    # MCP server — 6 tools, auto-generated agent codes
│   ├── store.ts     # Filesystem store — presence, messages, sessions
│   ├── hook.ts      # PreToolUse hook — checks inbox on every tool call
│   └── watcher.ts   # fs.watch — instant detection, asyncRewake push
├── skill/
│   └── SKILL.md     # Always-active skill for proactive coordination
└── store/           # Runtime data (gitignored)
    ├── presence/    # {code}.json — agent registration + PID
    ├── messages/    # {code}/*.json — per-agent inboxes
    └── sessions/    # {pid}.code — PID-to-agent-code mapping
```

### Session linking (how the hook finds "its" agent)

The MCP server and hooks both run as children of the same Claude Code process. On startup, the server writes its agent code to `sessions/{pid}.code` for each PID in its ancestor chain. The hook walks up its own ancestor chain and matches against these files — the common ancestor (Claude Code) is the link.

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code](https://claude.ai/code) v2.1+
- macOS or Linux

## License

MIT
