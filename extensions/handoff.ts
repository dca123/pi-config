import { complete, type Message, type Model } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionHeader,
} from "@mariozechner/pi-coding-agent";
import {
  BorderedLoader,
  buildSessionContext,
  convertToLlm,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";

const HANDOFF_GUARD_TOKEN_THRESHOLD = 250_000;
const HANDOFF_GUARD_PERCENT_THRESHOLD = 90;
const GUARD_STATE_TYPE = "local-handoff:guard-state";
const AUTO_HANDOFF_GOAL =
  "Continue the current discussion in a fresh session. Preserve the current design state, unresolved questions, alternatives considered, assumptions, and immediate next steps.";
const INTERNAL_COMMAND = "handoff-run";
const MAX_FILE_LIST_ITEMS = 40;

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
Suggest a handoff when the conversation is getting long or context is getting tight.
If a handoff prompt includes parent session paths, use the \`session_query\` tool to recover details on demand.`;

interface GuardState {
  suppressed: true;
  reason: "declined" | "dismissed";
}

interface PendingHandoff {
  goal: string;
  source: "tool" | "guard";
}

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

function createPendingId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
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

function isGuardState(value: unknown): value is GuardState {
  return (
    isRecord(value) &&
    value.suppressed === true &&
    (value.reason === "declined" || value.reason === "dismissed")
  );
}

function isGuardSuppressed(sessionManager: ExtensionContext["sessionManager"]): boolean {
  const branch = sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as SessionEntry & { customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== GUARD_STATE_TYPE) continue;
    return isGuardState(entry.data) && entry.data.suppressed;
  }
  return false;
}

function suppressGuard(pi: ExtensionAPI, reason: GuardState["reason"]): void {
  pi.appendEntry(GUARD_STATE_TYPE, { suppressed: true, reason } satisfies GuardState);
}

function shouldOfferHandoff(usage: { tokens: number | null; percent: number | null }): boolean {
  if (usage.tokens !== null && usage.tokens >= HANDOFF_GUARD_TOKEN_THRESHOLD) return true;
  if (usage.percent !== null && usage.percent >= HANDOFF_GUARD_PERCENT_THRESHOLD) return true;
  return false;
}

function formatUsage(usage: { tokens: number | null; percent: number | null }): string {
  const parts: string[] = [];
  if (usage.tokens !== null) parts.push(`${formatCount(usage.tokens)} tokens`);
  if (usage.percent !== null) parts.push(`${Math.round(usage.percent)}%`);
  return parts.join(" · ") || "high usage";
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
): Promise<GenerateResult> {
  return ctx.ui.custom<GenerateResult>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
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
        { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
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
  let guardPrompted = false;
  let guardSuppressed = false;
  const pendingHandoffs = new Map<string, PendingHandoff>();

  function hasSessionQueryTool(): boolean {
    return pi.getAllTools().some((tool) => tool.name === "session_query");
  }

  function queuePendingHandoff(goal: string, source: PendingHandoff["source"]): string {
    const id = createPendingId();
    pendingHandoffs.set(id, { goal, source });
    return id;
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

    const sessionName =
      normalizedGoal.length > 80 ? `${normalizedGoal.slice(0, 77)}...` : normalizedGoal;

    // Cast for forward-compatibility while still loading on Pi 0.67.x, whose
    // local ExtensionCommandContext typings do not yet include withSession.
    const switchResult = await ctx.newSession({
      parentSession,
      setup: async (sm) => {
        sm.appendSessionInfo(sessionName);
      },
      withSession: async (newCtx) => {
        newCtx.ui.setEditorText(editedPrompt);
        newCtx.ui.notify("Handoff ready — edit if needed, press Enter to send.", "info");
      },
    } as any);
    if (switchResult.cancelled) {
      ctx.ui.notify("New session cancelled.", "info");
      return;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    guardPrompted = false;
    guardSuppressed = isGuardSuppressed(ctx.sessionManager);
  });

  pi.on("before_agent_start", (event) => {
    return { systemPrompt: event.systemPrompt + HANDOFF_HINT };
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!ctx.hasUI || guardPrompted || guardSuppressed) return;

    const usage = ctx.getContextUsage();
    if (!usage || !shouldOfferHandoff(usage)) return;

    guardPrompted = true;
    const sessionBefore = ctx.sessionManager.getSessionFile();
    const choice = await ctx.ui.select(
      `Context at ${formatUsage(usage)} — handoff to a new session?`,
      ["Yes, handoff", "No, keep going"],
    );

    if (ctx.sessionManager.getSessionFile() !== sessionBefore) return;

    if (choice !== "Yes, handoff") {
      guardSuppressed = true;
      suppressGuard(pi, choice ? "declined" : "dismissed");
      return;
    }

    guardSuppressed = true;
    const id = queuePendingHandoff(AUTO_HANDOFF_GOAL, "guard");
    ctx.ui.setEditorText(`/${INTERNAL_COMMAND} ${id}`);
    ctx.ui.notify("Handoff prepared — press Enter to run it.", "info");
  });

  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session",
    handler: async (args, ctx) => {
      await runHandoff(args, ctx);
    },
  });

  pi.registerCommand(INTERNAL_COMMAND, {
    handler: async (args, ctx) => {
      const id = args.trim();
      const pending = pendingHandoffs.get(id);
      if (!pending) {
        ctx.ui.notify("No pending handoff found.", "warning");
        return;
      }
      pendingHandoffs.delete(id);
      await runHandoff(pending.goal, ctx);
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

      const id = queuePendingHandoff(goal, "tool");
      ctx.ui.setEditorText(`/${INTERNAL_COMMAND} ${id}`);

      return {
        content: [
          {
            type: "text" as const,
            text: "Prepared handoff command in the editor. After this turn finishes, press Enter to run it.",
          },
        ],
        details: {},
      };
    },
  });
}
