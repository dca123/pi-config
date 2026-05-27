import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Binding = {
  keys: string[];
  provider: string;
  modelId: string;
  label: string;
};

const BINDINGS: Binding[] = [
  {
    keys: ["f1", "alt+1"],
    provider: "openai-codex",
    modelId: "gpt-5.5",
    label: "GPT-5.5",
  },
  {
    keys: ["f2", "alt+2"],
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    label: "Opus 4.6",
  },
];

export default function (pi: ExtensionAPI) {
  for (const { keys, provider, modelId, label } of BINDINGS) {
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
          ctx.ui.notify(`Model: ${label}`, "success");
        },
      });
    }
  }
}
