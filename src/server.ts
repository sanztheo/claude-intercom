import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  register,
  unregisterSync,
  registerSessionSync,
  unregisterSessionSync,
  generateCode,
  detectProject,
  sendMessage,
  peekMessages,
  ackMessage,
  ackAll,
  listAgents,
} from "./store.js";

const agentCode = generateCode();
const pid = process.pid;
const project = detectProject();

await register(agentCode, pid, project);
const sessionPids = registerSessionSync(agentCode);

// Cleanup on exit — sync to ensure it runs
process.on("exit", () => {
  unregisterSync(agentCode);
  unregisterSessionSync(sessionPids);
});
process.on("SIGTERM", () => process.exit());
process.on("SIGINT", () => process.exit());

const server = new McpServer({
  name: "intercom",
  version: "1.0.0",
});

// --- who ---
server.tool(
  "who",
  `See which other Claude Code agents are currently active. Shows their code, project, and uptime.
Use this BEFORE starting work to check if other agents are working on the same project.
Use this to find an agent's code before sending them a message.
By default shows only agents on the same project. Set scope='all' to see everyone.`,
  {
    scope: z
      .enum(["project", "all"])
      .default("project")
      .describe("'project' = same project only, 'all' = all agents everywhere"),
  },
  async ({ scope }) => {
    const filter = scope === "project" ? project : undefined;
    const agents = await listAgents(filter);
    if (agents.length <= 1) {
      return {
        content: [
          {
            type: "text",
            text: `You are [${agentCode}] on project "${project}". No other agents ${scope === "project" ? "on this project" : "connected"}.`,
          },
        ],
      };
    }
    const list = agents
      .map((a) => {
        const tag = a.code === agentCode ? " (you)" : "";
        return `  ${a.code}${tag} — ${a.project} (since ${a.started})`;
      })
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `You are [${agentCode}] on "${project}"\n\nActive agents${scope === "project" ? ` on "${project}"` : ""}:\n${list}`,
        },
      ],
    };
  },
);

// --- send ---
server.tool(
  "send",
  `Send a message to another agent or broadcast.
Use 'all' as target to broadcast to all agents on the same project.
Use a specific code (from 'who') to message one agent directly.
Proactively send messages when:
- You're about to modify a file that others might be editing
- You need to coordinate a PR, merge, or deployment
- You want to ask what others are working on to avoid conflicts
- You finished a task that unblocks someone else`,
  {
    to: z
      .string()
      .describe("Agent code, or 'all' to broadcast to same-project agents"),
    message: z.string().describe("Free-form message content"),
  },
  async ({ to, message }) => {
    const projectFilter = to === "all" ? project : undefined;
    const msg = await sendMessage(
      agentCode,
      to,
      message,
      undefined,
      projectFilter,
    );
    const target = to === "all" ? `all agents on "${project}"` : to;
    return {
      content: [
        {
          type: "text",
          text: `[${agentCode}] Message sent to ${target} (id: ${msg.id})`,
        },
      ],
    };
  },
);

// --- reply ---
server.tool(
  "reply",
  `Reply to a specific message. Sends your response to the original sender and removes the original from your inbox.
Always reply to messages that ask you a question or request information.`,
  {
    message_id: z.string().describe("ID of the message to reply to"),
    message: z.string().describe("Your reply"),
  },
  async ({ message_id, message }) => {
    const myMessages = await peekMessages(agentCode);
    const original = myMessages.find((m) => m.id === message_id);
    if (!original) {
      return {
        content: [
          { type: "text", text: `Message ${message_id} not found in inbox.` },
        ],
      };
    }
    const msg = await sendMessage(
      agentCode,
      original.from,
      message,
      message_id,
    );
    await ackMessage(agentCode, message_id);
    return {
      content: [
        {
          type: "text",
          text: `[${agentCode}] Reply sent to ${original.from} (id: ${msg.id})`,
        },
      ],
    };
  },
);

// --- peek ---
server.tool(
  "peek",
  `Check your inbox for messages from other agents.
Call this at the START of any task and PERIODICALLY during long work.
If you have messages, read them and reply or acknowledge before continuing.`,
  {},
  async () => {
    const messages = await peekMessages(agentCode);
    if (messages.length === 0) {
      return {
        content: [{ type: "text", text: `[${agentCode}] No unread messages.` }],
      };
    }
    const list = messages
      .map(
        (m) =>
          `[${m.id}] from ${m.from}${m.reply_to ? ` (reply to ${m.reply_to})` : ""}:\n  ${m.message}`,
      )
      .join("\n\n");
    return {
      content: [
        {
          type: "text",
          text: `[${agentCode}] 📬 ${messages.length} message(s):\n\n${list}`,
        },
      ],
    };
  },
);

// --- ack ---
server.tool(
  "ack",
  "Mark a message as read and remove it from your inbox. Use after you've processed a message that doesn't need a reply.",
  {
    message_id: z.string().describe("Message ID to acknowledge"),
  },
  async ({ message_id }) => {
    const ok = await ackMessage(agentCode, message_id);
    return {
      content: [
        {
          type: "text",
          text: ok
            ? `Message ${message_id} acknowledged.`
            : `Message ${message_id} not found.`,
        },
      ],
    };
  },
);

// --- ack_all ---
server.tool(
  "ack_all",
  "Clear your entire inbox. Use when you've read all messages and none need a reply.",
  {},
  async () => {
    const count = await ackAll(agentCode);
    return {
      content: [
        {
          type: "text",
          text:
            count > 0
              ? `${count} message(s) acknowledged.`
              : "Inbox already empty.",
        },
      ],
    };
  },
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
