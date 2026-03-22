/**
 * Thread Switcher — Amp-style session switcher for pi.
 *
 * `/threads` command. Centered floating box over a live session preview.
 * Arrow keys change the background preview to show selected session content.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { parseSessionEntries } from "@mariozechner/pi-coding-agent";
import { SessionManager, type SessionInfo } from "@mariozechner/pi-coding-agent";
import { readFileSync, unlinkSync } from "node:fs";
import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  fuzzyFilter,
  type Focusable,
  CURSOR_MARKER,
} from "@mariozechner/pi-tui";

// ── Helpers ──────────────────────────────────────────────────────────

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function sessionLabel(s: SessionInfo): string {
  if (s.name) return s.name;
  const first = s.firstMessage.trim();
  if (!first) return "(empty)";
  return first.replace(/\s+/g, " ");
}

function cwdShort(cwd: string): string {
  if (!cwd) return "";
  const home = process.env.HOME || "";
  let p = cwd;
  if (home && p.startsWith(home)) p = "~" + p.slice(home.length);
  const parts = p.split("/");
  if (parts.length > 3) return parts[0] + "/…/" + parts.slice(-1)[0];
  return p;
}

// ── Session Preview ──────────────────────────────────────────────────

interface PreviewLine {
  text: string;
  role: "user" | "assistant" | "tool" | "gap";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

function parsePreview(sessionPath: string): PreviewLine[] {
  try {
    const content = readFileSync(sessionPath, "utf-8");
    const entries = parseSessionEntries(content);
    const lines: PreviewLine[] = [];

    for (const entry of entries) {
      if ((entry as any).type !== "message") continue;
      const msg = (entry as any).message;
      if (!msg?.role) continue;

      if (msg.role === "user") {
        lines.push({ text: "", role: "gap" });
        const text = extractText(msg.content).trim();
        if (text) {
          for (const line of text.split("\n")) {
            lines.push({ text: line, role: "user" });
          }
        }
      } else if (msg.role === "assistant") {
        const text = extractText(msg.content).trim();
        if (text) {
          for (const line of text.split("\n")) {
            lines.push({ text: line, role: "assistant" });
          }
        }
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type !== "toolCall" || !block.name) continue;
            const args = block.arguments || {};
            let toolLine: string;
            if (block.name === "bash" && args.command) {
              toolLine = `$ ${args.command}`;
            } else if ((block.name === "edit" || block.name === "write" || block.name === "read") && args.path) {
              toolLine = `${block.name} ${args.path}`;
            } else {
              toolLine = `${block.name}(…)`;
            }
            lines.push({ text: toolLine, role: "tool" });
          }
        }
      }
    }
    return lines;
  } catch {
    return [];
  }
}

const previewCache = new Map<string, PreviewLine[]>();

function getPreview(path: string): PreviewLine[] {
  let cached = previewCache.get(path);
  if (!cached) {
    cached = parsePreview(path);
    previewCache.set(path, cached);
  }
  return cached;
}

// ── Component ────────────────────────────────────────────────────────

interface ThreadItem {
  session: SessionInfo;
  isCurrent: boolean;
}

interface Opts {
  onSelect: (path: string) => void;
  onCancel: () => void;
  onPaste: (text: string) => void;
  onRename: (path: string, newName: string) => void;
  requestRender: () => void;
  theme: any;
  currentSessionFile?: string;
  getTermWidth: () => number;
  getTermHeight: () => number;
}

class ThreadSwitcher extends Container implements Focusable {
  private items: ThreadItem[] = [];
  private filtered: ThreadItem[] = [];
  private selected = 0;
  private listScroll = 0;
  private searchText = "";
  private opts: Opts;
  private scope: "current" | "all" = "current";
  private currentSessions: SessionInfo[] = [];
  private allSessions: SessionInfo[] | null = null;
  private loadingProgress: { loaded: number; total: number } | null = null;
  private notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private bgScroll = 0;
  private renaming = false;
  private renameText = "";
  private renameTarget: ThreadItem | null = null;

  _focused = false;
  get focused() { return this._focused; }
  set focused(v: boolean) { this._focused = v; }

  constructor(sessions: SessionInfo[], opts: Opts) {
    super();
    this.opts = opts;
    this.currentSessions = sessions;
    this.setSessions(sessions);
  }

  setAllSessions(sessions: SessionInfo[]) {
    this.allSessions = sessions;
    this.loadingProgress = null;
    if (this.scope === "all") this.setSessions(sessions);
  }

  setLoadingProgress(loaded: number, total: number) {
    this.loadingProgress = { loaded, total };
  }

  private setSessions(sessions: SessionInfo[]) {
    this.items = sessions.map((s) => ({
      session: s,
      isCurrent: s.path === this.opts.currentSessionFile,
    }));
    this.items.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
    this.applyFilter();
  }

  private applyFilter() {
    this.filtered = this.searchText
      ? fuzzyFilter(this.items, this.searchText, (i: ThreadItem) => sessionLabel(i.session))
      : this.items;
    this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
    this.listScroll = 0;
    this.invalidate();
  }

  private removeSession(path: string) {
    const remove = (list: SessionInfo[]) => {
      const idx = list.findIndex((s) => s.path === path);
      if (idx >= 0) list.splice(idx, 1);
    };
    remove(this.currentSessions);
    if (this.allSessions) remove(this.allSessions);
    previewCache.delete(path);
    this.setSessions(this.scope === "all" && this.allSessions ? this.allSessions : this.currentSessions);
  }

  private showNotice(msg: string) {
    this.notice = msg;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.invalidate();
      this.opts.requestRender();
    }, 2000);
    this.invalidate();
  }

  handleInput(data: string): void {
    // ── Rename mode ──
    if (this.renaming) {
      if (matchesKey(data, Key.escape)) {
        this.renaming = false; this.renameTarget = null; this.invalidate(); return;
      }
      if (matchesKey(data, Key.enter)) {
        const name = this.renameText.trim();
        if (name && this.renameTarget) {
          this.opts.onRename(this.renameTarget.session.path, name);
          this.renameTarget.session.name = name;
          this.showNotice("Renamed");
        }
        this.renaming = false; this.renameTarget = null; this.invalidate(); return;
      }
      if (matchesKey(data, Key.backspace)) {
        if (this.renameText.length > 0) this.renameText = this.renameText.slice(0, -1);
        this.invalidate(); return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.renameText += data; this.invalidate(); return;
      }
      return;
    }

    // ── Normal mode ──
    if (matchesKey(data, Key.escape)) { this.opts.onCancel(); return; }

    if (matchesKey(data, Key.enter)) {
      const sel = this.filtered[this.selected];
      if (sel && !sel.isCurrent) this.opts.onSelect(sel.session.path);
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.selected > 0) { this.selected--; this.bgScroll = 0; this.ensureVisible(); this.invalidate(); }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.selected < this.filtered.length - 1) { this.selected++; this.bgScroll = 0; this.ensureVisible(); this.invalidate(); }
      return;
    }

    // Shift+Up/Down: scroll background preview
    if (matchesKey(data, Key.shift("up"))) {
      this.bgScroll++;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.shift("down"))) {
      if (this.bgScroll > 0) { this.bgScroll--; this.invalidate(); }
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.scope = this.scope === "current" ? "all" : "current";
      this.setSessions(this.scope === "all" && this.allSessions ? this.allSessions : this.currentSessions);
      this.invalidate();
      return;
    }

    // Ctrl+P: paste first message into editor
    if (matchesKey(data, Key.ctrl("p"))) {
      const sel = this.filtered[this.selected];
      if (sel) {
        const text = sel.session.firstMessage.trim();
        if (text) { this.opts.onPaste(text); this.opts.onCancel(); }
        else { this.showNotice("Nothing to paste"); }
      }
      return;
    }

    // Ctrl+D: delete selected session
    if (matchesKey(data, Key.ctrl("d"))) {
      const sel = this.filtered[this.selected];
      if (sel && !sel.isCurrent) {
        try {
          unlinkSync(sel.session.path);
          this.removeSession(sel.session.path);
          this.showNotice("Session deleted");
        } catch { this.showNotice("Failed to delete"); }
      } else if (sel?.isCurrent) {
        this.showNotice("Can't delete current");
      }
      return;
    }

    // Ctrl+R: rename selected session
    if (matchesKey(data, Key.ctrl("r"))) {
      const sel = this.filtered[this.selected];
      if (sel) {
        this.renaming = true;
        this.renameTarget = sel;
        this.renameText = sel.session.name || "";
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      if (this.searchText.length > 0) { this.searchText = this.searchText.slice(0, -1); this.applyFilter(); }
      return;
    }

    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.searchText += data;
      this.applyFilter();
      return;
    }
  }

  private ensureVisible() {
    const max = this.maxVisibleItems();
    if (this.selected < this.listScroll) this.listScroll = this.selected;
    else if (this.selected >= this.listScroll + max) this.listScroll = this.selected - max + 1;
  }

  private maxVisibleItems(): number {
    // Compact box: max 10 items so background stays visible
    return Math.min(this.filtered.length, 10);
  }

  // ── Main render: background + composited overlay ───────────────────

  render(width: number): string[] {
    const termH = this.opts.getTermHeight();
    const t = this.opts.theme;

    // 1. Render the session preview as full background
    const bg = this.renderBackground(width, termH, t);

    // 2. Render the floating box (ensure it fits within terminal)
    const boxW = Math.min(Math.max(40, Math.floor(width * 0.75)), width - 2);
    const boxLines = this.renderBox(boxW, t);

    // 3. Composite: center the box on the background
    const boxStartRow = Math.max(1, Math.floor((termH - boxLines.length) / 2));
    const colOffset = Math.max(0, Math.floor((width - boxW) / 2));
    const leftPad = " ".repeat(colOffset);

    for (let i = 0; i < boxLines.length; i++) {
      const row = boxStartRow + i;
      if (row < bg.length) {
        bg[row] = truncateToWidth(leftPad + boxLines[i], width);
      }
    }

    return bg;
  }

  // ── Background: dimmed session preview ─────────────────────────────

  private renderBackground(width: number, height: number, t: any): string[] {
    const sel = this.filtered[this.selected];
    if (!sel) return this.emptyBg(width, height, t);

    const preview = getPreview(sel.session.path);
    if (preview.length === 0) return this.emptyBg(width, height, t);

    const formatted: string[] = [];
    for (const p of preview) {
      if (p.role === "gap") { formatted.push(""); continue; }

      const indent = p.role === "user" ? " " : "   ";
      let styled: string;
      if (p.role === "user") {
        styled = t.fg("dim", "│ " + p.text);
      } else if (p.role === "tool") {
        styled = t.fg("dim", "  " + p.text);
      } else {
        styled = t.fg("dim", "  " + p.text);
      }
      formatted.push(truncateToWidth(indent + styled, width));
    }

    // Show from the end (most recent), shifted by bgScroll
    const total = formatted.length;
    const maxScroll = Math.max(0, total - height);
    if (this.bgScroll > maxScroll) this.bgScroll = maxScroll;

    const endIdx = total - this.bgScroll;
    const startIdx = Math.max(0, endIdx - height);
    const visible = formatted.slice(startIdx, endIdx);

    // Pad top if preview is shorter than terminal
    while (visible.length < height) visible.unshift("");
    return visible;
  }

  private emptyBg(width: number, height: number, t: any): string[] {
    const lines: string[] = Array(height).fill("");
    const mid = Math.floor(height / 2);
    lines[mid] = truncateToWidth(
      " ".repeat(Math.max(0, Math.floor((width - 20) / 2))) + t.fg("dim", "(no session preview)"),
      width
    );
    return lines;
  }

  // ── Overlay box ────────────────────────────────────────────────────

  private renderBox(boxW: number, t: any): string[] {
    const innerW = boxW - 2;
    const lines: string[] = [];

    /** Truncate content to innerW, then right-pad to exactly innerW visible chars */
    const row = (content: string) => {
      const truncated = truncateToWidth(content, innerW);
      const vis = visibleWidth(truncated);
      const padding = " ".repeat(Math.max(0, innerW - vis));
      return t.fg("border", "│") + truncated + padding + t.fg("border", "│");
    };
    const emptyRow = () => row("");

    // ── Top border ──
    lines.push(t.fg("border", "╭" + "─".repeat(innerW) + "╮"));

    // ── Title (centered) ──
    const scopeTag = this.scope === "all" ? "All" : "Project";
    const totalCount = this.items.length;
    const filteredCount = this.filtered.length;
    const countStr = this.searchText
      ? t.fg("dim", `(${filteredCount}/${totalCount})`)
      : t.fg("dim", `(${totalCount})`);
    const loadingStr = this.scope === "all" && this.loadingProgress && !this.allSessions
      ? t.fg("warning", ` loading ${this.loadingProgress.loaded}/${this.loadingProgress.total}…`)
      : "";

    if (this.renaming) {
      // ── Rename mode ──
      const renameTitle = t.fg("warning", t.bold("Rename session"));
      const renamePadL = Math.max(1, Math.floor((innerW - visibleWidth(renameTitle)) / 2));
      lines.push(row(" ".repeat(renamePadL) + renameTitle));

      const rPrefix = t.fg("dim", " > ");
      const rText = this.renameText ? t.fg("text", this.renameText) : t.fg("dim", "enter name...");
      lines.push(row(rPrefix + rText + (this._focused ? CURSOR_MARKER : "")));

      lines.push(row(" " + t.fg("dim", "enter confirm · esc cancel")));
    } else {
      // ── Normal mode ──
      const titleContent = t.fg("accent", t.bold("Select a thread")) + "  " + t.fg("dim", scopeTag) + " " + countStr + loadingStr;
      const titlePadL = Math.max(1, Math.floor((innerW - visibleWidth(titleContent)) / 2));
      lines.push(row(" ".repeat(titlePadL) + titleContent));

      const sPrefix = t.fg("dim", " > ");
      const sText = this.searchText ? t.fg("text", this.searchText) : t.fg("dim", "type to filter...");
      lines.push(row(sPrefix + sText + (this._focused ? CURSOR_MARKER : "")));

      if (this.notice) {
        lines.push(row(" " + t.fg("warning", this.notice)));
      } else {
        lines.push(emptyRow());
      }
    }

    // ── Session list ──
    if (this.filtered.length === 0) {
      lines.push(row("  " + t.fg("warning", "No matching sessions")));
    } else {
      const visCount = this.maxVisibleItems();
      const start = this.listScroll;
      const end = Math.min(start + visCount, this.filtered.length);

      if (start > 0) lines.push(row("  " + t.fg("dim", `↑ ${start} more`)));

      for (let i = start; i < end; i++) {
        const item = this.filtered[i];
        const isSel = i === this.selected;
        const s = item.session;
        const label = sessionLabel(s);
        const time = relativeTime(s.modified);
        const msgs = s.messageCount > 0 ? `${s.messageCount}msg` : "";

        // Right side info
        const rightParts = [msgs, time].filter(Boolean).join(" ");
        const right = " " + t.fg("dim", rightParts) + " ";
        const rightW = visibleWidth(right);

        // Prefix
        let prefix: string;
        if (item.isCurrent) {
          prefix = " " + t.fg("warning", "(current)") + " " + t.fg("dim", "● ");
        } else if (isSel) {
          prefix = "  " + t.fg("accent", "❯ ");
        } else {
          prefix = "    ";
        }
        const prefixW = visibleWidth(prefix);
        const nameSpace = Math.max(10, innerW - prefixW - rightW);

        // Name
        let name: string;
        if (item.isCurrent && isSel) name = t.fg("accent", t.bold(label));
        else if (item.isCurrent) name = t.fg("muted", label);
        else if (isSel) name = t.fg("accent", t.bold(label));
        else name = t.fg("text", label);
        name = truncateToWidth(name, nameSpace);

        const padLen = Math.max(0, innerW - prefixW - visibleWidth(name) - rightW);
        lines.push(row(prefix + name + " ".repeat(padLen) + right));

        // CWD in "all" scope
        if (this.scope === "all" && s.cwd) {
          lines.push(row("      " + t.fg("dim", cwdShort(s.cwd))));
        }
      }

      if (end < this.filtered.length) {
        lines.push(row("  " + t.fg("dim", `↓ ${this.filtered.length - end} more`)));
      }
    }

    // ── Help ──
    lines.push(emptyRow());
    const helpItems = [
      "↑↓ navigate",
      "⇧↑↓ scroll bg",
      "enter select",
      "^r rename",
      "^p paste",
      "^d del",
      "esc close",
      `tab ${this.scope === "current" ? "all" : "project"}`,
    ];
    const helpStr = helpItems.map((s) => t.fg("dim", s)).join(t.fg("dim", " · "));
    lines.push(row(" " + helpStr));

    // ── Bottom border ──
    lines.push(t.fg("border", "╰" + "─".repeat(innerW) + "╯"));

    return lines;
  }

  invalidate(): void { super.invalidate(); }

  dispose(): void {
    previewCache.clear();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
  }
}

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  async function showThreadSwitcher(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) return;

    const cwd = ctx.cwd;
    const currentFile = ctx.sessionManager.getSessionFile();

    let sessions: SessionInfo[];
    try {
      sessions = await SessionManager.list(cwd);
    } catch {
      ctx.ui.notify("Failed to load sessions", "error");
      return;
    }

    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());

    if (sessions.length === 0) {
      ctx.ui.notify("No sessions found", "info");
      return;
    }

    previewCache.clear();

    const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const switcher = new ThreadSwitcher(sessions, {
        onSelect: (path: string) => done(path),
        onCancel: () => done(null),
        onPaste: (text: string) => ctx.ui.pasteToEditor(text),
        onRename: (path: string, newName: string) => {
          // Always use SessionManager.open() to get correct parentId/leafId chain
          if (path === currentFile) {
            pi.setSessionName(newName);
          } else {
            try {
              const mgr = SessionManager.open(path);
              mgr.appendSessionInfo(newName.trim());
            } catch {}
          }
        },
        requestRender: () => tui.requestRender(),
        theme,
        currentSessionFile: currentFile,
        getTermWidth: () => tui.terminal?.columns ?? 100,
        getTermHeight: () => tui.terminal?.rows ?? 40,
      });

      // Lazy-load all sessions with progress
      SessionManager.listAll((loaded: number, total: number) => {
        switcher.setLoadingProgress(loaded, total);
        tui.requestRender();
      })
        .then((all: SessionInfo[]) => {
          all.sort((a: SessionInfo, b: SessionInfo) => b.modified.getTime() - a.modified.getTime());
          switcher.setAllSessions(all);
          tui.requestRender();
        })
        .catch(() => {});

      return {
        render: (w: number) => switcher.render(w),
        invalidate: () => switcher.invalidate(),
        handleInput: (data: string) => { switcher.handleInput(data); tui.requestRender(); },
        dispose: () => switcher.dispose(),
      };
    });

    if (result) {
      const r = await ctx.switchSession(result);
      if (r.cancelled) ctx.ui.notify("Session switch cancelled", "info");
    }
  }

  pi.registerCommand("threads", {
    description: "Thread switcher with live session preview background",
    handler: async (_args, ctx) => { await showThreadSwitcher(ctx); },
  });
}
