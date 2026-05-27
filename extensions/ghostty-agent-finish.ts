import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let startedAt = 0;

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

export default function (pi: ExtensionAPI) {
  pi.on("agent_start", async () => {
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
    notifyGhostty("Pi", `Task finished after ${elapsedSeconds}s`);
  });
}
