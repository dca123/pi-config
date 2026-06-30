import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type Binding = {
  keys: string[];
  provider: string;
  modelId: string;
  label: string;
  thinking: ThinkingLevel;
};

const BINDINGS: Binding[] = [
  {
    keys: ["f1", "alt+1"],
    provider: "openai-codex",
    modelId: "gpt-5.5",
    label: "GPT-5.5",
    thinking: "low",
  },
  {
    keys: ["f2", "alt+2"],
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    label: "Opus 4.8",
    thinking: "high",
  },
];

export default function (pi: ExtensionAPI) {
  for (const { keys, provider, modelId, label, thinking } of BINDINGS) {
    for (const key of keys) {
      pi.registerShortcut(key, {
        description: `Switch to ${label}`,
        handler: async (ctx) => {
          const model = ctx.modelRegistry.find(provider, modelId);
          if (!model) {
            ctx.ui.notify(`Model not found: ${provider}/${modelId}`, "error");
            return;
          }
          const ok = await pi.setModel(model);
          if (!ok) {
            ctx.ui.notify(`No API key for ${provider}/${modelId}`, "error");
            return;
          }
          pi.setThinkingLevel(thinking);
          ctx.ui.notify(`${label} (thinking: ${thinking})`, "success");
        },
      });
    }
  }
}
