import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "open" | "done";

type TodoItem = {
	id: number;
	text: string;
	status: TodoStatus;
	createdAt: number;
};

type TodoState = {
	items: TodoItem[];
	nextId: number;
};

type ToolAction = "add" | "list" | "delete" | "clear";

type TodoToolDetails = TodoState & {
	action: ToolAction;
	error?: string;
};

type TodoPanelAction =
	| { type: "close" }
	| { type: "delete"; id: number }
	| { type: "clear" };

const TODO_TOOL_NAME = "todo_later";
const TODO_STATE_ENTRY = "todo-later-state";
const TODO_STATUS_KEY = "todo-later-count";

const TodoParams = Type.Object({
	action: StringEnum(["add", "list", "delete", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Deferred item text for add" })),
	id: Type.Optional(Type.Number({ description: "Todo item id for delete" })),
	confirmedByUser: Type.Optional(
		Type.Boolean({ description: "True only after the user explicitly confirmed adding this deferred item" }),
	),
});

function isTodoStatus(value: unknown): value is TodoStatus {
	return value === "open" || value === "done";
}

function parseTodoItem(value: unknown): TodoItem | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	if (typeof input.id !== "number") return undefined;
	if (typeof input.text !== "string") return undefined;
	if (!isTodoStatus(input.status)) return undefined;
	if (typeof input.createdAt !== "number") return undefined;
	return {
		id: input.id,
		text: input.text,
		status: input.status,
		createdAt: input.createdAt,
	};
}

function parseTodoState(value: unknown): TodoState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Record<string, unknown>;
	if (!Array.isArray(input.items)) return undefined;
	if (typeof input.nextId !== "number") return undefined;

	const items = input.items.map(parseTodoItem);
	if (items.some((item) => item === undefined)) return undefined;

	const maxId = items.reduce((max, item) => Math.max(max, item?.id ?? max), 0);
	return {
		items: items as TodoItem[],
		nextId: Math.max(input.nextId, maxId + 1),
	};
}

function cloneState(state: TodoState): TodoState {
	return {
		items: state.items.map((item) => ({ ...item })),
		nextId: state.nextId,
	};
}

function formatTodoList(items: TodoItem[]): string {
	if (items.length === 0) return "No deferred todos";
	return items.map((item) => `#${item.id}: ${item.text}`).join("\n");
}

function countOpenTodos(items: TodoItem[]): number {
	return items.filter((item) => item.status === "open").length;
}

function formatDate(timestamp: number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

class TodoPanel {
	private selectedIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly items: TodoItem[],
		private readonly theme: Theme,
		private readonly done: (action: TodoPanelAction) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ type: "close" });
			return;
		}

		if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.invalidate();
			return;
		}

		if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(Math.max(0, this.items.length - 1), this.selectedIndex + 1);
			this.invalidate();
			return;
		}

		if (data === "d" && this.items.length > 0) {
			const item = this.items[this.selectedIndex];
			if (item) this.done({ type: "delete", id: item.id });
			return;
		}

		if (data === "c" && this.items.length > 0) {
			this.done({ type: "clear" });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const title = this.theme.fg("accent", this.theme.bold(" /todo "));
		const borderWidth = Math.max(0, width - 8);
		lines.push(
			truncateToWidth(
				this.theme.fg("borderMuted", "─".repeat(3)) + title + this.theme.fg("borderMuted", "─".repeat(borderWidth)),
				width,
			),
		);
		lines.push("");

		if (this.items.length === 0) {
			lines.push(truncateToWidth(`  ${this.theme.fg("dim", "No deferred todos")}`, width));
		} else {
			for (const [index, item] of this.items.entries()) {
				const cursor = index === this.selectedIndex ? this.theme.fg("accent", "›") : " ";
				const id = this.theme.fg("accent", `#${item.id}`);
				const status = item.status === "done" ? this.theme.fg("success", "done") : this.theme.fg("muted", "open");
				const date = this.theme.fg("dim", formatDate(item.createdAt));
				const text = item.status === "done" ? this.theme.fg("dim", item.text) : this.theme.fg("text", item.text);
				lines.push(truncateToWidth(`${cursor} ${id} ${status} ${text} ${date}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${this.theme.fg("dim", "↑↓ select • d delete • c clear all • esc close")}`, width));
		lines.push(truncateToWidth(this.theme.fg("borderMuted", "─".repeat(width)), width));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function todoExtension(pi: ExtensionAPI) {
	let state: TodoState = { items: [], nextId: 1 };

	function ensureToolActive(): void {
		const activeTools = pi.getActiveTools();
		if (!activeTools.includes(TODO_TOOL_NAME)) {
			pi.setActiveTools([...activeTools, TODO_TOOL_NAME]);
		}
	}

	function setState(nextState: TodoState): void {
		state = cloneState(nextState);
	}

	function snapshot(): TodoState {
		return cloneState(state);
	}

	function updateTodoStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(TODO_STATUS_KEY, ctx.ui.theme.fg("dim", `todo left ${countOpenTodos(state.items)}`));
	}

	function details(action: ToolAction, error?: string): TodoToolDetails {
		return { ...snapshot(), action, error };
	}

	function persistSnapshot(): void {
		pi.appendEntry<TodoState>(TODO_STATE_ENTRY, snapshot());
	}

	function reconstructState(ctx: ExtensionContext): void {
		state = { items: [], nextId: 1 };

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY) {
				const restored = parseTodoState(entry.data);
				if (restored) setState(restored);
				continue;
			}

			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME) continue;

			const restored = parseTodoState(message.details);
			if (restored) setState(restored);
		}
	}

	function addTodo(text: string): TodoItem {
		const item: TodoItem = {
			id: state.nextId,
			text,
			status: "open",
			createdAt: Date.now(),
		};
		state = {
			items: [...state.items, item],
			nextId: state.nextId + 1,
		};
		return item;
	}

	function deleteTodo(id: number): boolean {
		const nextItems = state.items.filter((item) => item.id !== id);
		const deleted = nextItems.length !== state.items.length;
		state = { ...state, items: nextItems };
		return deleted;
	}

	function clearTodos(): number {
		const count = state.items.length;
		state = { items: [], nextId: 1 };
		return count;
	}

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: "Todo Later",
		description: "Manage session-scoped deferred todos for work the user explicitly says to do later.",
		promptSnippet: "Manage the session-scoped /todo deferred-work list",
		promptGuidelines: [
			"Use todo_later only for work the user explicitly defers to later; do not add ordinary implementation plan steps.",
			"Before calling todo_later with action=add, ask the user for confirmation unless the user directly asked to add that item to /todo.",
			"Do not surface /todo contents every turn; call todo_later with action=list only when the current task needs the deferred list.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list":
					updateTodoStatus(ctx);
					return {
						content: [{ type: "text", text: formatTodoList(state.items) }],
						details: details("list"),
					};

				case "add": {
					if (!params.confirmedByUser) {
						updateTodoStatus(ctx);
						return {
							content: [{ type: "text", text: "Ask the user to confirm before adding this deferred todo." }],
							details: details("add", "confirmation required"),
						};
					}

					if (!params.text?.trim()) {
						updateTodoStatus(ctx);
						return {
							content: [{ type: "text", text: "Text is required to add a deferred todo." }],
							details: details("add", "text required"),
						};
					}

					const item = addTodo(params.text.trim());
					updateTodoStatus(ctx);
					return {
						content: [{ type: "text", text: `Added deferred todo #${item.id}: ${item.text}` }],
						details: details("add"),
					};
				}

				case "delete": {
					if (params.id === undefined) {
						updateTodoStatus(ctx);
						return {
							content: [{ type: "text", text: "ID is required to delete a deferred todo." }],
							details: details("delete", "id required"),
						};
					}

					if (!deleteTodo(params.id)) {
						updateTodoStatus(ctx);
						return {
							content: [{ type: "text", text: `Deferred todo #${params.id} not found.` }],
							details: details("delete", `#${params.id} not found`),
						};
					}

					updateTodoStatus(ctx);
					return {
						content: [{ type: "text", text: `Deleted deferred todo #${params.id}.` }],
						details: details("delete"),
					};
				}

				case "clear": {
					const count = clearTodos();
					updateTodoStatus(ctx);
					return {
						content: [{ type: "text", text: `Deleted ${count} deferred todo(s).` }],
						details: details("clear"),
					};
				}

				default:
					updateTodoStatus(ctx);
					return {
						content: [{ type: "text", text: `Unknown todo_later action: ${String(params.action)}` }],
						details: details("list", "unknown action"),
					};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold(`${TODO_TOOL_NAME} `)) + theme.fg("muted", args.action);
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const restored = parseTodoState(result.details);
			const action = (result.details as Partial<TodoToolDetails> | undefined)?.action;
			const error = (result.details as Partial<TodoToolDetails> | undefined)?.error;

			if (error) return new Text(theme.fg("error", error), 0, 0);
			if (!restored || !action) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (action === "list") {
				return new Text(restored.items.length === 0 ? theme.fg("dim", "No deferred todos") : formatTodoList(restored.items), 0, 0);
			}

			if (action === "add") {
				const item = restored.items[restored.items.length - 1];
				return new Text(
					item ? theme.fg("success", `✓ Added #${item.id}`) + " " + theme.fg("muted", item.text) : theme.fg("dim", "No deferred todos"),
					0,
					0,
				);
			}

			if (action === "delete") return new Text(theme.fg("success", "✓ Deleted deferred todo"), 0, 0);
			return new Text(theme.fg("success", "✓ Cleared deferred todos"), 0, 0);
		},
	});

	pi.registerCommand("todo", {
		description: "Show the session deferred todo list",
		handler: async (_args, ctx) => {
			reconstructState(ctx);
			updateTodoStatus(ctx);

			if (ctx.mode !== "tui") {
				ctx.ui.notify(formatTodoList(state.items), "info");
				return;
			}

			while (true) {
				const action = await ctx.ui.custom<TodoPanelAction>(
					(tui, theme, _keybindings, done) => {
						const panel = new TodoPanel(snapshot().items, theme, done);
						return {
							render(width: number) {
								return panel.render(width);
							},
							invalidate() {
								panel.invalidate();
							},
							handleInput(data: string) {
								panel.handleInput(data);
								tui.requestRender();
							},
						};
					},
					{ overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "70%" } },
				);

				if (!action || action.type === "close") return;

				if (action.type === "delete") {
					if (deleteTodo(action.id)) {
						persistSnapshot();
						updateTodoStatus(ctx);
						ctx.ui.notify(`Deleted deferred todo #${action.id}`, "info");
					}
					continue;
				}

				if (state.items.length === 0) continue;
				const ok = await ctx.ui.confirm("Clear /todo?", `Delete all ${state.items.length} deferred todo(s)?`);
				if (ok) {
					const count = clearTodos();
					persistSnapshot();
					updateTodoStatus(ctx);
					ctx.ui.notify(`Deleted ${count} deferred todo(s)`, "info");
				}
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		reconstructState(ctx);
		ensureToolActive();
		updateTodoStatus(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		reconstructState(ctx);
		updateTodoStatus(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		persistSnapshot();
		updateTodoStatus(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		ensureToolActive();
		updateTodoStatus(ctx);
	});
}
