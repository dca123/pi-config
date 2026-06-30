import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let startedAt = 0;

const CHECK_PREFIX = "✓ ";

const writeOsc = (sequence: string) => {
  if (process.env.TERM_PROGRAM !== "ghostty") return;
  if (!process.stdout.isTTY) return;

  process.stdout.write(sequence);
};

const notifyGhostty = (title: string, body: string) => {
  // Ghostty/iTerm-style desktop notification. This is the same style used by
  // Pi's upstream notify extension and is more reliable from inside Pi's TUI
  // than depending only on shell command-finish markers.
  writeOsc(`\x1b]777;notify;${title};${body}\x07`);
};

const tmuxDisplay = (format: string): string | undefined => {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return undefined;

  try {
    return execFileSync("tmux", ["display-message", "-p", "-t", pane, format], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

const tmuxRenameWindow = (windowId: string, name: string): void => {
  try {
    execFileSync("tmux", ["rename-window", "-t", windowId, name], {
      stdio: "ignore",
    });
  } catch {
    // tmux can be absent or the pane may have moved; desktop notification is the fallback signal.
  }
};

const tmuxSetWindowOption = (windowId: string, optionName: string, value: string): void => {
  try {
    execFileSync("tmux", ["set-option", "-w", "-t", windowId, optionName, value], {
      stdio: "ignore",
    });
  } catch {
    // tmux can be absent or the pane may have moved; desktop notification is the fallback signal.
  }
};

const tmuxUnsetWindowOption = (windowId: string, optionName: string): void => {
  try {
    execFileSync("tmux", ["set-option", "-w", "-u", "-t", windowId, optionName], {
      stdio: "ignore",
    });
  } catch {
    // tmux can be absent or the pane may have moved; desktop notification is the fallback signal.
  }
};

const currentTmuxWindow = (): { id: string; name: string } | undefined => {
  const id = tmuxDisplay("#{window_id}");
  const name = tmuxDisplay("#W");
  if (!id || name === undefined) return undefined;

  return { id, name };
};

// The checkmark is a transient decoration on whatever the window is currently
// named. We never cache and restore a previous name: doing so would clobber a
// rename the user made while/after the agent ran. Strip on start, add on end.
const stripTmuxWindowMark = (): void => {
  const win = currentTmuxWindow();
  if (!win || !win.name.startsWith(CHECK_PREFIX)) return;

  tmuxRenameWindow(win.id, win.name.slice(CHECK_PREFIX.length));
  tmuxUnsetWindowOption(win.id, "@pi_original_name");
};

const markTmuxWindowDone = (): void => {
  const win = currentTmuxWindow();
  if (!win || win.name.startsWith(CHECK_PREFIX)) return;

  tmuxSetWindowOption(win.id, "@pi_original_name", win.name);
  tmuxRenameWindow(win.id, `${CHECK_PREFIX}${win.name}`);
};

export default function (pi: ExtensionAPI) {
  pi.on("agent_start", async () => {
    stripTmuxWindowMark();
    startedAt = Date.now();

    // Also emit command markers so Ghostty versions that recognize nested
    // OSC 133 command regions can apply notify-on-command-finish behavior.
    writeOsc("\x1b]133;C\x07");
  });

  pi.on("agent_end", async () => {
    const elapsedMs = Date.now() - startedAt;
    writeOsc("\x1b]133;D;0\x07");

    if (elapsedMs < 5000) return;

    const elapsedSeconds = Math.round(elapsedMs / 1000);
    markTmuxWindowDone();
    notifyGhostty("Pi", `Task finished after ${elapsedSeconds}s`);
  });
}
