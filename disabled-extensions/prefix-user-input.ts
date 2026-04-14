import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PREFIX = "Be extremely concise. Sacrifice grammar for the sake of concision.\n\nUser input:\n";

export default function (pi: ExtensionAPI) {
	pi.on("context", async (event) => {
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const msg = event.messages[i];
			if (msg.role !== "user") continue;

			const firstText = msg.content.find((c) => c.type === "text");
			if (!firstText) break;

			firstText.text = `${PREFIX}${firstText.text}`;
			break;
		}

		return { messages: event.messages };
	});
}
