import { complete, type Message, type Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";
import {
  BorderedLoader,
  buildSessionContext,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_FILE_LIST_ITEMS = 40;

// On-disk handoff store. `/handoff <goal>` saves the distilled prompt here and
// prints a `/handoff <id>` line; running that command in any new session on the
// same machine picks the handoff up.
const HANDOFF_STORE = join(homedir(), ".pi", "agent", "handoffs");
const HANDOFF_ID_RE = /^[a-z0-9]{6}$/;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

const SYSTEM_PROMPT = `You are a context transfer assistant. Read a pi coding session conversation and produce a strict handoff summary for a NEW session.

The user is often handing off during discussion and design work, not only implementation. Preserve what is still unresolved.

Do NOT continue the conversation.
Do NOT answer any open questions.
Do NOT invent facts.
Do NOT call tools.

Use this EXACT format:

## Goal
[One concise paragraph describing what the next session should focus on.]

## Constraints & Preferences
- [Explicit constraints, preferences, or requirements]
- [(none) if none were stated]

## Assumptions
- [Assumptions that the discussion is currently relying on]
- [(none) if none were stated]

## Progress
### Done
- [x] [Completed work or settled conclusions relevant to the goal]

### In Progress
- [ ] [Work that started but is not finished]

### Blocked
- [Blockers, if any]
- [(none) if none apply]

## Key Decisions
- **[Decision]**: [Brief rationale]
- Use code pointers like path/to/file.ts:42 or path/to/file.ts#symbol when relevant
- [(none) if nothing has been decided yet]

## Open Questions & Unresolved Decisions
- [Questions still open or choices still disputed]
- [(none) if everything relevant is already settled]

## Alternatives Considered
- **[Option]**: [Why it was rejected, deferred, or kept alive]
- [(none) if no meaningful alternatives were discussed]

## Next Steps
1. [Concrete next discussion or execution step]
2. [Next step]
- If the discussion is still exploratory, focus these steps on resolving the open questions above.

## Critical Context
- [Non-obvious facts, examples, commands, errors, invariants, or references needed to continue]
- [(none) if none apply]

Rules:
- Be concise and concrete.
- Preserve exact file paths, function names, commands, and error messages.
- Include only information relevant to the stated goal.
- Preserve unresolved questions and alternatives briefly when they matter.
- Do NOT add a separate Task section.
- Output markdown only. No preamble.`;

const HANDOFF_HINT = `
## Handoff

Use the \`handoff\` tool only when the user explicitly asks to move the work into a new session.
Do NOT suggest handoffs proactively. Only use handoff when the user explicitly asks.
If a handoff prompt includes parent session paths, use the \`session_query\` tool to recover details on demand.`;

const RECAP_SYSTEM_PROMPT = `You are a session recap assistant. Read a pi coding session conversation and produce a concise accomplishment summary to bring back to the parent session that initiated this work.

The parent session handed off a task to this session. Now the work is done (or paused), and we need to report back what happened.

Do NOT continue the conversation.
Do NOT answer any open questions.
Do NOT invent facts.
Do NOT call tools.

Use this EXACT format:

## Recap

### Accomplished
- [x] [What was completed]

### Key Changes
- **[File/area]**: [What changed and why]
- Use code pointers like path/to/file.ts:42 or path/to/file.ts#symbol when relevant
- [(none) if no files were changed]

### Decisions Made
- **[Decision]**: [Brief rationale]
- [(none) if no notable decisions]

### Still Open
- [ ] [Items not finished or deferred]
- [(none) if everything was completed]

### Notes
- [Non-obvious findings, caveats, gotchas, or context the parent session needs]
- [(none) if nothing notable]

Rules:
- Be concise and concrete.
- Focus on outcomes and artifacts, not process.
- Preserve exact file paths, function names, commands, and error messages.
- Output markdown only. No preamble.`;

type GenerateResult =
  | { type: "prompt"; text: string }
  | { type: "error"; message: string }
  | null;

interface FileOps {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeGoal(goal: string): string {
  return goal.replace(/\s+/g, " ").trim();
}

function randomHandoffId(): string {
  let id = "";
  for (let i = 0; i < 6; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return id;
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) return raw;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return raw;
  return raw.slice(end + 5).replace(/^\n+/, "");
}

function saveHandoff(
  doc: string,
  goal: string,
  parent: string | undefined,
  type: "handoff" | "recap" = "handoff",
): string {
  mkdirSync(HANDOFF_STORE, { recursive: true });
  let id = randomHandoffId();
  while (existsSync(join(HANDOFF_STORE, `${id}.md`))) id = randomHandoffId();
  const frontmatter = [
    "---",
    `id: ${id}`,
    `type: ${type}`,
    `created: ${new Date().toISOString()}`,
    `goal: ${JSON.stringify(goal)}`,
    `parent: ${parent ? JSON.stringify(parent) : "null"}`,
    "---",
    "",
    "",
  ].join("\n");
  writeFileSync(join(HANDOFF_STORE, `${id}.md`), frontmatter + doc, "utf-8");
  return id;
}

function loadHandoff(id: string): string | null {
  const file = join(HANDOFF_STORE, `${id}.md`);
  if (!existsSync(file)) return null;
  try {
    return stripFrontmatter(readFileSync(file, "utf-8")).trim();
  } catch {
    return null;
  }
}

function handoffLabel(id: string): string {
  try {
    const raw = readFileSync(join(HANDOFF_STORE, `${id}.md`), "utf-8");
    const typeMatch = raw.match(/^type:\s*(.*)$/m);
    const type = typeMatch ? typeMatch[1].trim() : "handoff";
    const match = raw.match(/^goal:\s*(.*)$/m);
    const goal = match ? match[1].trim().replace(/^"(.*)"$/, "$1") : "";
    const prefix = type === "recap" ? "↩ " : "";
    return goal ? `${id} — ${prefix}${goal.slice(0, 60)}` : `${id}${prefix ? " — " + prefix.trim() : ""}`;
  } catch {
    return id;
  }
}

function makeFileOps(): FileOps {
  return {
    read: new Set(),
    written: new Set(),
    edited: new Set(),
  };
}

function extractFileOpsFromMessage(message: unknown, fileOps: FileOps): void {
  if (!isRecord(message) || message.role !== "assistant") return;
  if (!Array.isArray(message.content)) return;

  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    const name = typeof block.name === "string" ? block.name : undefined;
    const args = isRecord(block.arguments) ? block.arguments : undefined;
    const path = typeof args?.path === "string" ? args.path : undefined;
    if (!name || !path) continue;

    switch (name) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
    }
  }
}

function limitList(items: string[], max = MAX_FILE_LIST_ITEMS): string[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `... ${items.length - max} more omitted`];
}

function buildFileAppendix(messages: unknown[]): string {
  const fileOps = makeFileOps();
  for (const message of messages) {
    extractFileOpsFromMessage(message, fileOps);
  }

  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((path) => !modified.has(path)).sort();
  const modifiedFiles = [...modified].sort();
  const sections: string[] = [];

  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${limitList(readFiles).join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${limitList(modifiedFiles).join("\n")}\n</modified-files>`);
  }

  return sections.join("\n\n");
}

function gatherConversation(ctx: ExtensionContext): { text: string; messages: unknown[] } | null {
  const branch = ctx.sessionManager.getBranch();
  const leafId = ctx.sessionManager.getLeafId();
  const { messages } = buildSessionContext(branch, leafId);
  if (messages.length === 0) return null;

  return {
    text: serializeConversation(convertToLlm(messages)),
    messages,
  };
}

function getSessionHeader(sessionFile: string): SessionHeader | null {
  try {
    if (!existsSync(sessionFile)) return null;
    const content = readFileSync(sessionFile, "utf-8");
    const lineEnd = content.indexOf("\n");
    const firstLine = (lineEnd === -1 ? content : content.slice(0, lineEnd)).trim();
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    return parsed?.type === "session" ? (parsed as SessionHeader) : null;
  } catch {
    return null;
  }
}

function getSessionAncestry(parentSessionFile: string): string[] {
  const ancestry: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = parentSessionFile;

  while (current && !seen.has(current)) {
    seen.add(current);
    ancestry.push(current);
    current = getSessionHeader(current)?.parentSession;
  }

  return ancestry;
}

function buildRecallPreamble(parentSessionFile: string | undefined, hasSessionQuery: boolean): string {
  if (!parentSessionFile) return "";

  const ancestry = getSessionAncestry(parentSessionFile);
  if (ancestry.length === 0) return "";

  const lines = ["## Session Recall", "", `**Parent session:** \`${ancestry[0]}\``];

  if (ancestry.length > 1) {
    lines.push("", "**Ancestor sessions:**");
    for (let i = 1; i < ancestry.length; i++) {
      lines.push(`- \`${ancestry[i]}\``);
    }
  }

  if (hasSessionQuery) {
    lines.push(
      "",
      "Use the `session_query` tool if you need more detail from one of these sessions.",
      `Example: \`session_query("${ancestry[0]}", "What did we decide about X?")\``,
    );
  }

  return lines.join("\n");
}

async function resolveAuth(
  ctx: ExtensionContext,
  model: Model<any>,
): Promise<{ apiKey: string; headers?: Record<string, string> }> {
  const registry = ctx.modelRegistry as any;

  if (typeof registry.getApiKeyAndHeaders === "function") {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth?.ok) {
      throw new Error(auth?.error ?? `No API key for ${model.provider}/${model.id}`);
    }
    if (!auth.apiKey) {
      throw new Error(`No API key for ${model.provider}/${model.id}`);
    }
    return { apiKey: auth.apiKey, headers: auth.headers };
  }

  const apiKey = await registry.getApiKey(model);
  if (!apiKey) {
    throw new Error(`No API key for ${model.provider}/${model.id}`);
  }
  return { apiKey };
}

async function generateHandoffSummary(
  conversationText: string,
  goal: string,
  ctx: ExtensionContext,
  overrideSystemPrompt?: string,
  loaderText = "Generating handoff prompt...",
): Promise<GenerateResult> {
  return ctx.ui.custom<GenerateResult>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, loaderText);
    loader.onAbort = () => done(null);

    const run = async () => {
      const { apiKey, headers } = await resolveAuth(ctx, ctx.model!);
      const userMessage: Message = {
        role: "user",
        content: [
          {
            type: "text",
            text: `## Conversation History\n\n${conversationText}\n\n## Goal For The New Session\n\n${goal}`,
          },
        ],
        timestamp: Date.now(),
      };

      const response = await complete(
        ctx.model!,
        { systemPrompt: overrideSystemPrompt ?? SYSTEM_PROMPT, messages: [userMessage] },
        { apiKey, headers, signal: loader.signal },
      );

      if (response.stopReason === "aborted") return null;
      if (response.stopReason === "error") {
        return {
          type: "error" as const,
          message:
            "errorMessage" in response && typeof response.errorMessage === "string"
              ? response.errorMessage
              : "LLM request failed",
        };
      }

      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      if (!text) {
        return { type: "error" as const, message: "LLM returned empty response" };
      }

      return { type: "prompt" as const, text };
    };

    run()
      .then(done)
      .catch((error) => {
        done({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return loader;
  });
}

export default function (pi: ExtensionAPI) {
  function hasSessionQueryTool(): boolean {
    return pi.getAllTools().some((tool) => tool.name === "session_query");
  }

  async function runHandoff(goal: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Handoff requires interactive mode.", "error");
      return;
    }

    if (!ctx.model) {
      ctx.ui.notify("No model selected.", "error");
      return;
    }

    const normalizedGoal = normalizeGoal(goal) || "Continue the current discussion in a fresh session.";

    const gathered = gatherConversation(ctx);
    if (!gathered) {
      ctx.ui.notify("No conversation to hand off.", "error");
      return;
    }

    const result = await generateHandoffSummary(gathered.text, normalizedGoal, ctx);
    if (!result) {
      ctx.ui.notify("Handoff cancelled.", "info");
      return;
    }
    if (result.type === "error") {
      ctx.ui.notify(`Handoff failed: ${result.message}`, "error");
      return;
    }

    const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
    const parts: string[] = [];
    const recallPreamble = buildRecallPreamble(parentSession, hasSessionQueryTool());
    const fileAppendix = buildFileAppendix(gathered.messages);

    if (recallPreamble) parts.push(recallPreamble);
    parts.push(result.text.trim());
    if (fileAppendix) parts.push(fileAppendix);

    const finalPrompt = parts.join("\n\n");
    const editedPrompt = await ctx.ui.editor("Edit handoff prompt", finalPrompt);
    if (editedPrompt === undefined) {
      ctx.ui.notify("Handoff cancelled.", "info");
      return;
    }

    const id = saveHandoff(editedPrompt, normalizedGoal, parentSession);
    pi.sendMessage(
      {
        customType: "handoff-saved",
        content: `Handoff saved → /handoff ${id}`,
        display: true,
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    ctx.ui.notify(`Handoff saved → /handoff ${id}  (run that in a new pane)`, "info");
  }

  async function pickupHandoff(id: string, ctx: ExtensionCommandContext): Promise<void> {
    const doc = loadHandoff(id);
    if (!doc) {
      ctx.ui.notify(`Handoff ${id} not found.`, "error");
      return;
    }
    ctx.ui.notify(`Picking up handoff ${id}.`, "info");
    pi.sendUserMessage(doc);
  }

  async function runRecap(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Recap requires interactive mode.", "error");
      return;
    }
    if (!ctx.model) {
      ctx.ui.notify("No model selected.", "error");
      return;
    }

    const gathered = gatherConversation(ctx);
    if (!gathered) {
      ctx.ui.notify("No conversation to recap.", "error");
      return;
    }

    const result = await generateHandoffSummary(
      gathered.text,
      "Produce a recap of what was accomplished in this session.",
      ctx,
      RECAP_SYSTEM_PROMPT,
      "Generating recap...",
    );
    if (!result) {
      ctx.ui.notify("Recap cancelled.", "info");
      return;
    }
    if (result.type === "error") {
      ctx.ui.notify(`Recap failed: ${result.message}`, "error");
      return;
    }

    const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    const fileAppendix = buildFileAppendix(gathered.messages);
    const parts: string[] = [result.text.trim()];
    if (fileAppendix) parts.push(fileAppendix);
    const finalDoc = parts.join("\n\n");

    const editedDoc = await ctx.ui.editor("Edit recap", finalDoc);
    if (editedDoc === undefined) {
      ctx.ui.notify("Recap cancelled.", "info");
      return;
    }

    const id = saveHandoff(editedDoc, "Session recap", sessionFile, "recap");
    pi.sendMessage(
      {
        customType: "recap-saved",
        content: `Recap saved → /handoff ${id}`,
        display: true,
      },
      { triggerTurn: false, deliverAs: "nextTurn" },
    );
    ctx.ui.notify(`Recap saved → /handoff ${id}  (run that in the parent session)`, "info");
  }

  pi.on("before_agent_start", (event) => {
    return { systemPrompt: event.systemPrompt + HANDOFF_HINT };
  });

  pi.registerCommand("handoff", {
    description: "Hand off to a new session, or /handoff <id> to pick one up",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = ["recap"];
      const items: { value: string; label: string }[] = subcommands
        .filter((cmd) => cmd.startsWith(prefix))
        .map((cmd) => ({ value: cmd, label: cmd }));

      if (existsSync(HANDOFF_STORE)) {
        for (const name of readdirSync(HANDOFF_STORE)) {
          if (!name.endsWith(".md")) continue;
          const sid = name.slice(0, -3);
          if (!sid.startsWith(prefix)) continue;
          items.push({ value: sid, label: handoffLabel(sid) });
        }
      }
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "recap") {
        await runRecap(ctx);
        return;
      }
      if (HANDOFF_ID_RE.test(arg) && existsSync(join(HANDOFF_STORE, `${arg}.md`))) {
        await pickupHandoff(arg, ctx);
        return;
      }
      await runHandoff(args, ctx);
    },
  });

  pi.registerTool({
    name: "handoff",
    label: "Handoff",
    description:
      "Transfer context to a new focused session. Only use this when the user explicitly asks to move the current work into a new session.",
    promptSnippet: "Transfer context to a new focused session with a structured handoff prompt",
    promptGuidelines: [
      "Use this only when the user explicitly asks to move work into a new session.",
      "Pass a concise goal describing what the next session should focus on.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Goal for the new session" }),
    }) as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text" as const, text: "Handoff requires interactive mode." }],
          details: {},
        };
      }

      const goal = normalizeGoal(String((params as any).goal ?? ""));
      if (!goal) {
        return {
          content: [{ type: "text" as const, text: "Missing handoff goal." }],
          details: {},
        };
      }

      await runHandoff(goal, ctx as ExtensionCommandContext);

      return {
        content: [
          {
            type: "text" as const,
            text: "Handoff flow started.",
          },
        ],
        details: {},
      };
    },
  });
}
