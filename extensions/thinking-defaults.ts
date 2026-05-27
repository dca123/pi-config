import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const defaults: [RegExp, string][] = [
    [/claude-opus-4/, "high"],
    [/gpt-5\.4/, "medium"],
    [/gpt-5\.5/, "low"],
  ];

  pi.on("model_select", async (event) => {
    const match = defaults.find(([pattern]) => pattern.test(event.model.id));
    if (match) pi.setThinkingLevel(match[1] as any);
  });
}
