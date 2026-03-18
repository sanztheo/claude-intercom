import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import {
  unlinkSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const HOME = process.env.HOME ?? "~";
const STORE_DIR = join(HOME, ".claude", "mcp-intercom", "store");
const PRESENCE_DIR = join(STORE_DIR, "presence");
const MESSAGES_DIR = join(STORE_DIR, "messages");
const SESSIONS_DIR = join(STORE_DIR, "sessions");

export interface PresenceInfo {
  code: string;
  pid: number;
  project: string;
  started: string;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  message: string;
  timestamp: string;
  reply_to: string | null;
}

async function ensureDirs(): Promise<void> {
  await mkdir(PRESENCE_DIR, { recursive: true });
  await mkdir(MESSAGES_DIR, { recursive: true });
  await mkdir(SESSIONS_DIR, { recursive: true });
}

export function generateCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(4);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getPpid(pid: number): number {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf-8",
    });
    return parseInt(out.trim(), 10);
  } catch {
    return 0;
  }
}

function getAncestorPids(pid: number, maxDepth: number = 4): number[] {
  const ancestors: number[] = [pid];
  let current = pid;
  for (let i = 0; i < maxDepth && current > 1; i++) {
    const ppid = getPpid(current);
    if (ppid > 1) ancestors.push(ppid);
    current = ppid;
  }
  return ancestors;
}

export function detectProject(): string {
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      cwd: process.cwd(),
    }).trim();
    const parts = gitRoot.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? gitRoot;
  } catch {
    // Not a git repo — fall back to cwd
    const parts = process.cwd().split("/").filter(Boolean);
    return parts[parts.length - 1] ?? process.cwd();
  }
}

// --- Session management (links PID ancestor chain → agent code) ---

export function registerSessionSync(code: string): number[] {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const pids = getAncestorPids(process.pid);
  for (const pid of pids) {
    writeFileSync(join(SESSIONS_DIR, `${pid}.code`), code);
  }
  return pids;
}

export function unregisterSessionSync(pids: number[]): void {
  for (const pid of pids) {
    try {
      unlinkSync(join(SESSIONS_DIR, `${pid}.code`));
    } catch {}
  }
}

export function findMyCodeSync(): string | null {
  if (!existsSync(SESSIONS_DIR)) return null;
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    const file = join(SESSIONS_DIR, `${pid}.code`);
    if (existsSync(file)) {
      try {
        return readFileSync(file, "utf-8").trim();
      } catch {}
    }
    pid = getPpid(pid);
  }
  return null;
}

// --- Sync peek for hook ---

export function peekMessagesSync(code: string): Message[] {
  const inbox = join(MESSAGES_DIR, code);
  try {
    const files = readdirSync(inbox);
    const messages: Message[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        messages.push(JSON.parse(readFileSync(join(inbox, file), "utf-8")));
      } catch {}
    }
    return messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

// --- Async functions (for MCP server) ---

export async function register(
  code: string,
  pid: number,
  project: string,
): Promise<void> {
  await ensureDirs();
  await writeFile(
    join(PRESENCE_DIR, `${code}.json`),
    JSON.stringify({ code, pid, project, started: new Date().toISOString() }),
  );
  await mkdir(join(MESSAGES_DIR, code), { recursive: true });
}

export function unregisterSync(code: string): void {
  try {
    unlinkSync(join(PRESENCE_DIR, `${code}.json`));
  } catch {}
}

export async function listAgents(
  projectFilter?: string,
): Promise<PresenceInfo[]> {
  await ensureDirs();
  const files = await readdir(PRESENCE_DIR);
  const agents: PresenceInfo[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const data: PresenceInfo = JSON.parse(
        await readFile(join(PRESENCE_DIR, file), "utf-8"),
      );
      if (isPidAlive(data.pid)) {
        if (!projectFilter || data.project === projectFilter) {
          agents.push(data);
        }
      } else {
        await unlink(join(PRESENCE_DIR, file)).catch(() => {});
      }
    } catch {}
  }

  return agents;
}

export async function sendMessage(
  from: string,
  to: string,
  message: string,
  replyTo?: string,
  projectOnly?: string,
): Promise<Message> {
  const id = `msg-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const msg: Message = {
    id,
    from,
    to,
    message,
    timestamp: new Date().toISOString(),
    reply_to: replyTo ?? null,
  };

  const writeToInbox = async (recipient: string, data: Message) => {
    const inbox = join(MESSAGES_DIR, recipient);
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, `${id}.json`), JSON.stringify(data));
  };

  if (to === "all") {
    const agents = await listAgents(projectOnly);
    await Promise.all(
      agents
        .filter((a) => a.code !== from)
        .map((a) => writeToInbox(a.code, { ...msg, to: a.code })),
    );
  } else {
    await writeToInbox(to, msg);
  }

  return msg;
}

export async function peekMessages(code: string): Promise<Message[]> {
  const inbox = join(MESSAGES_DIR, code);
  try {
    const files = await readdir(inbox);
    const messages: Message[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        messages.push(JSON.parse(await readFile(join(inbox, file), "utf-8")));
      } catch {}
    }
    return messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

export async function ackMessage(
  code: string,
  messageId: string,
): Promise<boolean> {
  try {
    await unlink(join(MESSAGES_DIR, code, `${messageId}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function ackAll(code: string): Promise<number> {
  const messages = await peekMessages(code);
  let count = 0;
  for (const msg of messages) {
    if (await ackMessage(code, msg.id)) count++;
  }
  return count;
}
