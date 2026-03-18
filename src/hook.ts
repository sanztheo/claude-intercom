import { findMyCodeSync, peekMessagesSync } from "./store.js";

// Read stdin to check if this is an intercom tool call (skip to avoid duplicates)
let input = "";
try {
  input = await Bun.stdin.text();
} catch {}

if (input) {
  try {
    const data = JSON.parse(input);
    if (
      typeof data.tool_name === "string" &&
      data.tool_name.startsWith("mcp__intercom__")
    ) {
      process.exit(0);
    }
  } catch {}
}

// Find which agent code belongs to this Claude Code instance
const code = findMyCodeSync();
if (!code) process.exit(0);

// Check inbox
const messages = peekMessagesSync(code);
if (messages.length === 0) process.exit(0);

// Output messages — this gets injected into the agent's context
const lines = messages.map(
  (m) => `  [${m.id}] ${m.from}${m.reply_to ? " (reply)" : ""}: ${m.message}`,
);

console.log(
  `\n📬 INTERCOM [${code}] — ${messages.length} message(s) en attente:\n${lines.join("\n")}\n→ Utilise reply(message_id, message) pour répondre ou ack(message_id) pour accuser réception.\n`,
);

process.exit(0);
