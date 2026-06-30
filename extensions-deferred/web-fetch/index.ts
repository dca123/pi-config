import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import TurndownService from "turndown";
import { access, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 120;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const GITHUB_CACHE_ROOT = path.join(homedir(), ".pi", "agent", "cache", "web-fetch", "github");

const turndown = new TurndownService({
  headingStyle: "atx",
  hr: "---",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});
turndown.remove(["script", "style", "meta", "link", "noscript"]);

export default function webFetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch web content from a URL. For normal pages, returns markdown/text/html. For GitHub repo URLs, clones/updates the repo locally and returns repo/file/directory content instead of scraping HTML.",
    promptSnippet: "Fetch a URL. GitHub repo URLs are cloned locally; normal pages are fetched and converted to markdown/text/html.",
    promptGuidelines: [
      "Use this tool when you need the contents of a URL.",
      "Prefer format 'markdown' for normal web pages unless raw HTML is specifically needed.",
      "For GitHub URLs, prefer this tool over scraping the rendered GitHub HTML.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "HTTP(S) URL to fetch" }),
      format: Type.Optional(
        Type.Union([
          Type.Literal("markdown"),
          Type.Literal("text"),
          Type.Literal("html"),
        ], { description: "Output format for normal web pages. Default: markdown" }),
      ),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 30, max 120)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const format = params.format ?? "markdown";
      const timeoutMs = Math.min(Math.max(1, params.timeout ?? DEFAULT_TIMEOUT_S) * 1000, MAX_TIMEOUT_S * 1000);
      const url = normalizeUrl(params.url);
      const parsed = new URL(url);

      if (parsed.hostname === "github.com" || parsed.hostname === "www.github.com") {
        return handleGitHubUrl(url);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
      const combinedSignal = anySignal([signal, controller.signal]);

      try {
        const headers = buildHeaders(format);
        const initial = await fetch(url, { headers, signal: combinedSignal });
        const response =
          initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
            ? await fetch(url, {
                headers: { ...headers, "User-Agent": "pi-web-fetch" },
                signal: combinedSignal,
              })
            : initial;

        if (!response.ok) throw new Error(`Request failed with status code ${response.status}`);

        const contentLength = response.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
          throw new Error("Response too large (exceeds 5MB limit)");
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_RESPONSE_SIZE) throw new Error("Response too large (exceeds 5MB limit)");

        const contentType = response.headers.get("content-type") || "";
        const mime = contentType.split(";")[0]?.trim().toLowerCase() || "";
        const title = `${url} (${contentType || "unknown"})`;

        if (mime.startsWith("image/") && mime !== "image/svg+xml") {
          return textResult(`Fetched image URL: ${url}\nContent-Type: ${contentType}`, { url, contentType });
        }

        const text = new TextDecoder().decode(buffer);
        const output = convertContent(text, mime, format);
        return textResult(output, { url, contentType, format });
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("URL must start with http:// or https://");
  return trimmed.replace(/^http:\/\//i, "https://");
}

function buildHeaders(format: "markdown" | "text" | "html") {
  let accept = "*/*";
  if (format === "markdown") {
    accept = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
  } else if (format === "text") {
    accept = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
  } else if (format === "html") {
    accept = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }

  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
  };
}

function convertContent(content: string, mime: string, format: "markdown" | "text" | "html") {
  const isHtml = mime.includes("text/html") || /<html[\s>]/i.test(content) || /<!doctype html/i.test(content);
  if (!isHtml) return content;
  if (format === "html") return content;
  if (format === "markdown") return turndown.turndown(content);
  return htmlToText(content);
}

function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseGitHubUrl(url: string) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("GitHub URL must include owner/repo");

  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, "");
  const mode = parts[2] === "blob" || parts[2] === "tree" ? parts[2] : "repo";
  const refAndPath = parts.slice(3);
  return { owner, repo, mode, refAndPath, originalUrl: url } as const;
}

async function handleGitHubUrl(url: string) {
  const info = parseGitHubUrl(url);
  const repoDir = path.join(GITHUB_CACHE_ROOT, info.owner, info.repo);
  await ensureRepoUpToDate(info.owner, info.repo, repoDir, info.mode === "repo" ? undefined : info.refAndPath[0]);

  if (info.mode === "repo") {
    const readme = await readReadme(repoDir);
    const tree = await listDirectory(repoDir, 2);
    const head = await gitOutput(repoDir, ["rev-parse", "HEAD"]);
    const body = [
      `Cloned GitHub repo locally.`,
      `Local path: ${repoDir}`,
      `HEAD: ${head.trim()}`,
      ``,
      `Tree:`,
      tree,
      readme ? `\nREADME:\n\n${readme}` : "",
    ].join("\n");
    return textResult(body.trim(), { url, repoDir, mode: "repo" });
  }

  const { ref, relativePath } = await resolveGitHubRefPath(repoDir, info.refAndPath);
  if (!relativePath) throw new Error(`Could not resolve path from GitHub URL: ${url}`);

  const target = path.join(repoDir, relativePath);
  const targetStat = await stat(target).catch(() => null);
  if (!targetStat) {
    throw new Error(`Resolved GitHub path not found in clone: ${relativePath} (ref ${ref})`);
  }

  if (info.mode === "blob") {
    if (!targetStat.isFile()) throw new Error(`GitHub blob path is not a file: ${relativePath}`);
    const content = await readFile(target, "utf8");
    return textResult(`GitHub file from local clone\nLocal path: ${target}\nRef: ${ref}\n\n${content}`, {
      url,
      repoDir,
      localPath: target,
      ref,
      mode: "blob",
    });
  }

  if (!targetStat.isDirectory()) throw new Error(`GitHub tree path is not a directory: ${relativePath}`);
  const listing = await listDirectory(target, 2);
  return textResult(`GitHub directory from local clone\nLocal path: ${target}\nRef: ${ref}\n\n${listing}`, {
    url,
    repoDir,
    localPath: target,
    ref,
    mode: "tree",
  });
}

async function ensureRepoUpToDate(owner: string, repo: string, repoDir: string, requestedRef?: string) {
  await mkdir(path.dirname(repoDir), { recursive: true });
  const remoteUrl = `https://github.com/${owner}/${repo}.git`;

  if (!(await exists(path.join(repoDir, ".git")))) {
    await mkdir(path.dirname(repoDir), { recursive: true });
    await execGit(path.dirname(repoDir), ["clone", "--depth", "1", remoteUrl, repoDir]);
  }

  await execGit(repoDir, ["remote", "set-url", "origin", remoteUrl]);
  await execGit(repoDir, ["fetch", "--prune", "origin"]);

  if (requestedRef) {
    const fetched = await tryFetchRef(repoDir, requestedRef);
    if (fetched) {
      await execGit(repoDir, ["checkout", "--force", "FETCH_HEAD"]);
      await execGit(repoDir, ["clean", "-fd"]);
      return;
    }
  }

  const defaultBranch = await getDefaultBranch(repoDir);
  await execGit(repoDir, ["fetch", "--depth", "1", "origin", defaultBranch]);
  await execGit(repoDir, ["checkout", "-B", defaultBranch, `origin/${defaultBranch}`]);
  await execGit(repoDir, ["clean", "-fd"]);
}

async function tryFetchRef(repoDir: string, ref: string) {
  const attempts = [
    ["fetch", "--depth", "1", "origin", ref],
    ["fetch", "--depth", "1", "origin", `${ref}:${ref}`],
  ];
  for (const args of attempts) {
    try {
      await execGit(repoDir, args);
      return true;
    } catch {}
  }
  return false;
}

async function getDefaultBranch(repoDir: string) {
  const symbolic = (await gitOutput(repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  if (symbolic.startsWith("refs/remotes/origin/")) return symbolic.replace("refs/remotes/origin/", "");
  const remoteShow = await gitOutput(repoDir, ["remote", "show", "origin"]);
  const match = remoteShow.match(/HEAD branch: (.+)/);
  return match?.[1]?.trim() || "main";
}

async function resolveGitHubRefPath(repoDir: string, refAndPath: readonly string[]) {
  if (refAndPath.length < 2) return { ref: refAndPath[0] ?? "HEAD", relativePath: refAndPath[1] ?? "" };

  for (let i = refAndPath.length; i >= 1; i--) {
    const ref = refAndPath.slice(0, i).join("/");
    const relativePath = refAndPath.slice(i).join("/");
    if (!relativePath) continue;
    const fullPath = path.join(repoDir, relativePath);
    if (await exists(fullPath)) return { ref, relativePath };
  }

  return { ref: refAndPath[0] ?? "HEAD", relativePath: refAndPath.slice(1).join("/") };
}

async function readReadme(repoDir: string) {
  for (const name of ["README.md", "README", "readme.md", "Readme.md"]) {
    const file = path.join(repoDir, name);
    if (await exists(file)) {
      const content = await readFile(file, "utf8");
      return content.length > 20000 ? `${content.slice(0, 20000)}\n\n[README truncated]` : content;
    }
  }
  return "";
}

async function listDirectory(dir: string, depth: number, prefix = ""): Promise<string> {
  if (depth < 0) return "";
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.name !== ".git")
    .sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];

  for (const entry of entries.slice(0, 200)) {
    const marker = entry.isDirectory() ? "/" : "";
    lines.push(`${prefix}${entry.name}${marker}`);
    if (entry.isDirectory() && depth > 0) {
      const nested = await listDirectory(path.join(dir, entry.name), depth - 1, `${prefix}  `);
      if (nested) lines.push(nested);
    }
  }
  if (entries.length > 200) lines.push(`${prefix}... [directory listing truncated]`);
  return lines.join("\n");
}

async function execGit(cwd: string, args: string[]) {
  const result = await piExec("git", args, cwd);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result;
}

async function gitOutput(cwd: string, args: string[]) {
  const result = await execGit(cwd, args);
  return result.stdout;
}

async function exists(target: string) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function piExec(command: string, args: string[], cwd: string) {
  const { spawn } = await import("node:child_process");
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function anySignal(signals: Array<AbortSignal | undefined>) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
