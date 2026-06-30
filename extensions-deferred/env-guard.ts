/**
 * Env Guard Extension
 *
 * Blocks read/write/edit of .env* files (which contain secrets).
 * Allows .env.example (shape-only, no secrets).
 * On read attempts, returns a sanitized version with values masked.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function sanitizeEnvContent(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      // Preserve comments and blank lines
      if (!trimmed || trimmed.startsWith("#")) return line;
      // Mask values: KEY=xxx
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) return line;
      const key = line.slice(0, eqIndex);
      return `${key}=xxx`;
    })
    .join("\n");
}

function tryReadAndSanitize(filePath: string, cwd: string): string | null {
  try {
    const absolute = resolve(cwd, filePath);
    const content = readFileSync(absolute, "utf-8");
    return sanitizeEnvContent(content);
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  const ENV_PATTERN = /(?:^|[/\\])\.env(?:\..+)?$/;
  const SAFE_PATTERN = /\.env\.example$/;

  function isBlockedEnvFile(path: string): boolean {
    return ENV_PATTERN.test(path) && !SAFE_PATTERN.test(path);
  }

  pi.on("tool_call", async (event, ctx) => {
    let path: string | undefined;

    if (
      isToolCallEventType("read", event) ||
      isToolCallEventType("write", event) ||
      isToolCallEventType("edit", event)
    ) {
      path = event.input.path;
    }

    // Catch bash commands that read .env files
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;
      if (/\b(cat|less|more|head|tail|sed|source|\.)\s+.*\.env\b/.test(cmd)) {
        // Try to extract the .env file path from the command
        const match = cmd.match(/\.env[.\w]*/);
        const envPath = match?.[0];
        let sanitized: string | null = null;
        if (envPath) {
          sanitized = tryReadAndSanitize(envPath, ctx.cwd);
        }

        if (ctx.hasUI) {
          ctx.ui.notify("Blocked bash command that reads .env* file", "warning");
        }

        const reason = sanitized
          ? `This file contains secrets and cannot be read directly. Here is a sanitized version (values masked):\n\n${sanitized}`
          : "Reading .env* files is blocked (they contain secrets). Read .env.example for the expected shape.";

        return { block: true, reason };
      }
    }

    if (!path) return undefined;
    if (!isBlockedEnvFile(path)) return undefined;

    if (ctx.hasUI) {
      ctx.ui.notify(`Blocked access to secret env file: ${path}`, "warning");
    }

    // For reads, return sanitized content. For writes/edits, just block.
    if (isToolCallEventType("read", event)) {
      const sanitized = tryReadAndSanitize(path, ctx.cwd);
      if (sanitized) {
        return {
          block: true,
          reason: `This file contains secrets and cannot be read directly. Here is a sanitized version (values masked):\n\n${sanitized}`,
        };
      }
    }

    return {
      block: true,
      reason: `Access to "${path}" is blocked because it contains secrets. Read .env.example for the expected shape.`,
    };
  });
}
