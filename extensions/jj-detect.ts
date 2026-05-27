import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event, ctx) => {
    if (existsSync(join(ctx.cwd, ".jj"))) {
      return {
        systemPrompt:
          _event.systemPrompt +
          `\n\n## JJ Repository Detection\n- This repo is JJ-managed (.jj/ detected)\n- Prefer \`jj\` over \`git\` for local repository operations`,
      };
    }
  });
}
