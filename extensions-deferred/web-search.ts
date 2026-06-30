/**
 * Unified web search extension for pi.
 *
 * Routes queries to the best provider based on intent:
 *   - "factual" → Tavily (agent-optimized, high factual accuracy, content extraction built in)
 *   - "research" → Exa (semantic/neural, deep modes)
 *   - "auto" (default) → tries Tavily first, falls back to Exa
 *
 * Tavily API: https://docs.tavily.com
 * Exa API via MCP: https://mcp.exa.ai/mcp
 *
 * API keys:
 *   TAVILY_API_KEY — env var or macOS Keychain (service: TAVILY_API_KEY)
 *   EXA_API_KEY    — env var or macOS Keychain (service: EXA_API_KEY)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Rate limiting (shared) ──────────────────────────────────────────────

function createRateLimiter(qps: number) {
  const minInterval = Math.ceil(1000 / qps);
  let chain = Promise.resolve();
  let lastAt = 0;

  return async function schedule<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = async () => {
      const waitMs = Math.max(0, lastAt + minInterval - Date.now());
      if (waitMs > 0) await wait(waitMs, signal);
      lastAt = Date.now();
      return task();
    };
    const scheduled = chain.then(run, run);
    chain = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  };
}

async function wait(ms: number, signal?: AbortSignal) {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new Error("Aborted")); };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ── API key resolution ──────────────────────────────────────────────────

async function getApiKey(envName: string): Promise<string | undefined> {
  const envVal = process.env[envName]?.trim();
  if (envVal) return envVal;

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password", "-a", process.env.USER || "", "-s", envName, "-w",
      ]);
      const key = stdout.trim();
      if (key) return key;
    } catch { /* not in keychain */ }
  }
  return undefined;
}

// ── Tavily Search ───────────────────────────────────────────────────────

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  rawContent?: string;
  publishedDate?: string;
}

interface TavilyResponse {
  query: string;
  results: TavilyResult[];
  answer?: string;
  responseTime: number;
}

const tavilyRate = createRateLimiter(10);

async function searchTavily(
  apiKey: string,
  query: string,
  opts: {
    maxResults?: number;
    searchDepth?: "basic" | "advanced";
    includeRawContent?: boolean;
    includeDomains?: string[];
    excludeDomains?: string[];
    topic?: "general" | "news";
    includeAnswer?: boolean;
    chunksPerSource?: number;
  },
  signal?: AbortSignal,
): Promise<{ provider: "tavily"; results: SearchResult[]; answer?: string }> {
  const body: Record<string, unknown> = {
    query,
    max_results: opts.maxResults ?? 5,
    search_depth: opts.searchDepth ?? "basic",
    include_raw_content: opts.includeRawContent ?? false,
    include_answer: opts.includeAnswer ?? false,
  };
  if (opts.topic) body.topic = opts.topic;
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;
  if (opts.chunksPerSource) body.chunks_per_source = opts.chunksPerSource;

  const res = await tavilyRate(
    () => fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    }),
    signal,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily API error (${res.status}): ${text}`);
  }

  const data: TavilyResponse = await res.json();
  const results: SearchResult[] = data.results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
    score: r.score,
    rawContent: r.rawContent,
    date: r.publishedDate,
  }));

  return { provider: "tavily", results, answer: data.answer };
}

// ── Exa Search (via MCP) ────────────────────────────────────────────────

const exaRate = createRateLimiter(10);

type ExaSearchType = "auto" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning";

async function searchExa(
  apiKey: string,
  query: string,
  opts: {
    numResults?: number;
    type?: ExaSearchType;
    category?: string;
    systemPrompt?: string;
    additionalQueries?: string[];
  },
  signal?: AbortSignal,
): Promise<{ provider: "exa"; results: SearchResult[]; raw: string }> {
  const exaMcpUrl = `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(apiKey)}&tools=web_search_exa`;

  const args: Record<string, unknown> = {
    query,
    type: opts.type ?? "auto",
    numResults: opts.numResults ?? 5,
  };
  if (opts.category) args.category = opts.category;
  if (opts.systemPrompt) args.systemPrompt = opts.systemPrompt;
  if (opts.additionalQueries?.length) args.additionalQueries = opts.additionalQueries;

  const searchRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: args,
    },
  };

  const res = await exaRate(
    () => fetch(exaMcpUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(searchRequest),
      signal,
    }),
    signal,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exa MCP error (${res.status}): ${text}`);
  }

  const txt = await res.text();

  // Parse SSE: find first data: {json} with content
  for (const line of txt.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = JSON.parse(line.slice("data: ".length));
    const content0 = data?.result?.content?.[0]?.text;
    if (content0) {
      return { provider: "exa", results: [], raw: content0 };
    }
  }

  return { provider: "exa", results: [], raw: "No results found." };
}

// ── Shared types ────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  rawContent?: string;
  date?: string;
}

function formatTavilyResults(query: string, results: SearchResult[], answer?: string): string {
  if (results.length === 0) return `No Tavily results for "${query}".`;

  let text = "";
  if (answer) {
    text += `**Answer:** ${answer}\n\n---\n\n`;
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    text += `Title: ${r.title}\nURL: ${r.url}\n`;
    if (r.score) text += `Relevance: ${(r.score * 100).toFixed(0)}%\n`;
    if (r.date) text += `Published: ${r.date}\n`;
    text += `${r.snippet}\n`;
    if (r.rawContent) {
      // Truncate raw content to ~3000 chars to avoid flooding context
      const raw = r.rawContent.length > 3000
        ? r.rawContent.slice(0, 3000) + "\n[...truncated]"
        : r.rawContent;
      text += `\nFull content:\n${raw}\n`;
    }
    text += "\n";
  }
  return text;
}

// ── Extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Cache resolved keys
  let tavilyKeyPromise: Promise<string | undefined> | undefined;
  let exaKeyPromise: Promise<string | undefined> | undefined;

  function getTavilyKey() { return (tavilyKeyPromise ??= getApiKey("TAVILY_API_KEY")); }
  function getExaKey() { return (exaKeyPromise ??= getApiKey("EXA_API_KEY")); }

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web. Routes to the best provider based on intent:\n" +
      "- provider='tavily' → fast factual lookups (~1s, agent-optimized, content extraction built in)\n" +
      "- provider='exa' → semantic/research queries (neural search, deep modes, find-similar)\n" +
      "- provider='auto' (default) → Tavily for factual, Exa for exploratory/research\n\n" +
      "Tavily: use searchDepth='advanced' for thorough results. Set includeAnswer=true for LLM-synthesized answer.\n" +
      "Exa modes: 'auto' (default), 'deep-lite' (4s, light synthesis), 'deep' (4-15s, structured), 'deep-reasoning' (12-40s, maximum reasoning).",
    promptSnippet: "Search the web via Tavily (factual) or Exa (research/semantic). Set provider based on query intent.",
    promptGuidelines: [
      "Use this tool when you need up-to-date information from the web.",
      "For factual lookups (what is X, who is Y, latest news about Z): use provider='tavily'.",
      "For thorough factual research: use provider='tavily' with searchDepth='advanced' and includeRawContent=true.",
      "For research/exploratory queries (how does X work, compare A vs B, find similar to): use provider='exa'.",
      "For deep research requiring multi-source synthesis: use provider='exa' with exaType='deep' or 'deep-reasoning'.",
      "Default provider='auto' routes automatically — prefer being explicit when you know the intent.",
      "Prefer a focused query and a small number of results (e.g., 5-10).",
      "If the user asks for sources, include the returned URLs.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      numResults: Type.Optional(
        Type.Integer({ description: "Number of results (default 5)", minimum: 1, maximum: 20 }),
      ),
      provider: Type.Optional(
        Type.Union([
          Type.Literal("auto"),
          Type.Literal("tavily"),
          Type.Literal("exa"),
        ], { description: "Search provider: 'auto' (default), 'tavily' (fast factual), 'exa' (semantic/research)", default: "auto" }),
      ),
      // Tavily-specific
      searchDepth: Type.Optional(
        Type.Union([
          Type.Literal("basic"),
          Type.Literal("advanced"),
        ], { description: "Tavily only: 'basic' (fast, 1 credit) or 'advanced' (thorough, extracts best content, 2 credits)" }),
      ),
      includeRawContent: Type.Optional(
        Type.Boolean({ description: "Tavily only: include full parsed page content in results (useful for deep reading)" }),
      ),
      includeAnswer: Type.Optional(
        Type.Boolean({ description: "Tavily only: include an LLM-synthesized answer alongside results" }),
      ),
      topic: Type.Optional(
        Type.Union([
          Type.Literal("general"),
          Type.Literal("news"),
        ], { description: "Tavily only: 'general' (default) or 'news' (includes published dates)" }),
      ),
      includeDomains: Type.Optional(
        Type.Array(Type.String(), { description: "Tavily only: restrict results to these domains" }),
      ),
      excludeDomains: Type.Optional(
        Type.Array(Type.String(), { description: "Tavily only: exclude results from these domains" }),
      ),
      // Exa-specific
      exaType: Type.Optional(
        Type.Union([
          Type.Literal("auto"),
          Type.Literal("fast"),
          Type.Literal("deep-lite"),
          Type.Literal("deep"),
          Type.Literal("deep-reasoning"),
        ], { description: "Exa search type. 'auto' (default ~1s), 'deep-lite' (~4s), 'deep' (4-15s, structured), 'deep-reasoning' (12-40s, max reasoning)" }),
      ),
      exaCategory: Type.Optional(
        Type.String({ description: "Exa category filter: 'research paper', 'news', 'company', 'people', 'personal site', 'financial data'" }),
      ),
      exaSystemPrompt: Type.Optional(
        Type.String({ description: "Exa system prompt to guide synthesis, e.g., 'focus on technical architecture, not marketing'" }),
      ),
      additionalQueries: Type.Optional(
        Type.Array(Type.String(), { description: "Exa deep modes: additional query variations for broader coverage (max 10)", maxItems: 10 }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const numResults = params.numResults ?? 5;
      const provider = params.provider ?? "auto";

      const tavilyKey = await getTavilyKey();
      const exaKey = await getExaKey();

      // ── Route ──
      if (provider === "tavily" || (provider === "auto" && tavilyKey)) {
        if (!tavilyKey) {
          if (provider === "tavily") {
            throw new Error(
              "TAVILY_API_KEY not configured. Set it in env or macOS Keychain:\n" +
              "  security add-generic-password -a \"$USER\" -s TAVILY_API_KEY -w\n" +
              "  Get a free key at https://tavily.com (1000 free/mo, no card)"
            );
          }
          // auto mode, no tavily key — fall through to exa
        } else {
          try {
            const { results, answer } = await searchTavily(tavilyKey, params.query, {
              maxResults: numResults,
              searchDepth: params.searchDepth,
              includeRawContent: params.includeRawContent,
              includeAnswer: params.includeAnswer,
              topic: params.topic,
              includeDomains: params.includeDomains,
              excludeDomains: params.excludeDomains,
            }, signal);

            const text = formatTavilyResults(params.query, results, answer);
            return {
              content: [{ type: "text", text }],
              details: {
                query: params.query,
                provider: "tavily",
                searchDepth: params.searchDepth ?? "basic",
                numResults: results.length,
              },
            };
          } catch (e) {
            if (provider === "tavily") throw e;
            // auto mode: Tavily failed, fall through to Exa
          }
        }
      }

      // ── Exa ──
      if (!exaKey) {
        throw new Error(
          "No search API configured. Set at least one:\n" +
          "  TAVILY_API_KEY — https://tavily.com (1000 free/mo, no card)\n" +
          "  EXA_API_KEY — https://exa.ai (1000 free/mo)\n" +
          "Store in env or macOS Keychain: security add-generic-password -a \"$USER\" -s KEY_NAME -w"
        );
      }

      const { raw } = await searchExa(exaKey, params.query, {
        numResults,
        type: params.exaType as ExaSearchType | undefined,
        category: params.exaCategory,
        systemPrompt: params.exaSystemPrompt,
        additionalQueries: params.additionalQueries,
      }, signal);

      return {
        content: [{ type: "text", text: raw }],
        details: {
          query: params.query,
          provider: "exa",
          exaType: params.exaType ?? "auto",
          numResults,
        },
      };
    },
  });

  // ── Commands ──

  pi.registerCommand("search", {
    description: "Quick web search. Usage: /search <query>",
    handler: async (args, ctx) => {
      const query = (args || "").trim();
      if (!query) { ctx.ui.notify("Usage: /search <query>", "error"); return; }
      pi.sendUserMessage(`Use the web_search tool to search for: ${query}. Return results with URLs.`);
    },
  });

  pi.registerCommand("tavily", {
    description: "Search via Tavily. Usage: /tavily <query>",
    handler: async (args, ctx) => {
      const query = (args || "").trim();
      if (!query) { ctx.ui.notify("Usage: /tavily <query>", "error"); return; }
      pi.sendUserMessage(`Use the web_search tool with provider='tavily' to search for: ${query}. Return results with URLs.`);
    },
  });

  pi.registerCommand("exa", {
    description: "Search via Exa. Usage: /exa <query>",
    handler: async (args, ctx) => {
      const query = (args || "").trim();
      if (!query) { ctx.ui.notify("Usage: /exa <query>", "error"); return; }
      pi.sendUserMessage(`Use the web_search tool with provider='exa' to search for: ${query}. Return results with URLs.`);
    },
  });
}
