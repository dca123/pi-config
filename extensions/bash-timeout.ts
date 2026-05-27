import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT = 60;

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("bash", event)) {
      if (event.input.timeout == null) {
        event.input.timeout = DEFAULT_TIMEOUT;
      }
    }
  });
}
