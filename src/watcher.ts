import { watch } from "node:fs";
import { join } from "node:path";
import { findMyCodeSync, peekMessagesSync } from "./store.js";

const HOME = process.env.HOME ?? "~";
const MESSAGES_DIR = join(HOME, ".claude", "mcp-intercom", "store", "messages");

// Retry findMyCodeSync — MCP server might not be registered yet (race condition)
let code: string | null = null;
for (let attempt = 0; attempt < 15; attempt++) {
  code = findMyCodeSync();
  if (code) break;
  await Bun.sleep(2000);
}
if (!code) process.exit(0);

const inbox = join(MESSAGES_DIR, code);

function checkAndNotify(): boolean {
  const messages = peekMessagesSync(code!);
  if (messages.length === 0) return false;
  const lines = messages.map(
    (m) => `  [${m.id}] ${m.from}${m.reply_to ? " (reply)" : ""}: ${m.message}`,
  );
  console.log(
    `\n📬 INTERCOM [${code}] — ${messages.length} message(s):\n${lines.join("\n")}\n→ Utilise mcp__intercom__reply(message_id, message) pour répondre ou mcp__intercom__ack(message_id) pour accuser réception.\n`,
  );
  return true;
}

// Check immediately in case messages already exist
if (checkAndNotify()) process.exit(2);

// Watch inbox directory for new files — instant detection
try {
  const watcher = watch(inbox, (_event, filename) => {
    if (filename?.endsWith(".json")) {
      if (checkAndNotify()) {
        watcher.close();
        process.exit(2);
      }
    }
  });

  // Safety timeout: 5 minutes max
  setTimeout(() => {
    watcher.close();
    process.exit(0);
  }, 300_000);
} catch {
  // Inbox dir doesn't exist yet — fall back to polling
  for (let i = 0; i < 150; i++) {
    if (checkAndNotify()) process.exit(2);
    await Bun.sleep(2000);
  }
  process.exit(0);
}
