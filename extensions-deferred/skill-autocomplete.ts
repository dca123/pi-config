import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

const MAX_SUGGESTIONS = 20;

function extractSkillToken(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(/(?:^|[ \t])\$([^\s$]*)$/);
	return match?.[1];
}

function createSkillAutocompleteProvider(
	current: AutocompleteProvider,
	getSkills: () => AutocompleteItem[],
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const token = extractSkillToken(textBeforeCursor);
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const allSkills = getSkills();
			if (allSkills.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			let items: AutocompleteItem[];
			if (!token.trim()) {
				items = allSkills.slice(0, MAX_SUGGESTIONS);
			} else {
				items = fuzzyFilter(allSkills, token, (s) => s.value)
					.slice(0, MAX_SUGGESTIONS);
			}

			if (items.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return {
				items,
				prefix: `$${token}`,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const skillItems: AutocompleteItem[] = pi
			.getCommands()
			.filter((c) => c.source === "skill")
			.map((c) => ({
				value: `$${c.name.replace(/^skill:/, "")}`,
				label: `$${c.name.replace(/^skill:/, "")}`,
				description: c.description ?? "",
			}));

		ctx.ui.addAutocompleteProvider((current) =>
			createSkillAutocompleteProvider(current, () => skillItems),
		);
	});
}
