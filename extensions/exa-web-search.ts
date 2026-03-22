import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * Exa web search tool for pi.
 *
 * Uses the Exa MCP endpoint (same approach as OpenCode): https://mcp.exa.ai/mcp
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search (Exa MCP)",
    description:
      "Search the web using Exa's MCP endpoint (https://mcp.exa.ai/mcp). Returns Exa's LLM-optimized context.",
    promptSnippet: "Search the web via Exa MCP (query -> LLM-optimized context)",
    promptGuidelines: [
      "Use this tool when you need up-to-date information from the web.",
      "Prefer a focused query and a small number of results (e.g., 5-10).",
      "If the user asks for sources, include the returned URLs.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      numResults: Type.Optional(
        Type.Integer({ description: "Number of results (default 5)", minimum: 1, maximum: 20 }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const numResults = params.numResults ?? 5;


      // OpenCode-style Exa MCP call (SSE transcript parsing, not streaming)
      const searchRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: params.query,
            type: "auto" as const,
            numResults,
            livecrawl: "fallback" as const,
            // contextMaxCharacters: 10000, // optional
          },
        },
      };

      const res = await fetch("https://mcp.exa.ai/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(searchRequest),
        signal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Exa MCP error (${res.status}): ${errorText}`);
      }

      const txt = await res.text();

      // Parse SSE response transcript: find first data: {json}
      for (const line of txt.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = JSON.parse(line.slice("data: ".length));
        const content0 = data?.result?.content?.[0]?.text;
        if (content0) {
          return {
            content: [{ type: "text", text: content0 }],
            details: {
              query: params.query,
              numResults,
              raw: data,
            },
          };
        }
      }

      return {
        content: [{ type: "text", text: "No search results found. Please try a different query." }],
        details: {
          query: params.query,
          numResults,
          raw: txt,
        },
      };
    },
  });

  pi.registerCommand("exa", {
    description: "Run a quick Exa web search. Usage: /exa <query>",
    handler: async (args, ctx) => {
      const query = (args || "").trim();
      if (!query) {
        ctx.ui.notify("Usage: /exa <query>", "error");
        return;
      }

      // Send a user message that nudges the model to call the tool.
      // (Commands run outside the LLM loop, so we ask the agent to use the tool.)
      pi.sendUserMessage(
        `Use the web_search tool (Exa) to search for: ${query}. Return 5 results with URLs.`,
      );
    },
  });
}
