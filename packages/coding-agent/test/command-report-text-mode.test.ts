import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { ContextInsightsView } from "@oh-my-pi/pi-tui/status-line/context-insights";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const ROWS = 32;

function screen(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

describe("text-mode command reports on a real terminal core", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-command-report-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(120, ROWS);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function mountTranscript(rows: number): Promise<string> {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		for (let i = 0; i < rows; i++) mode.chatContainer.addChild(new Text(`TRANSCRIPT ${i}`, 0, 0));
		mode.ui.requestRender();
		const last = `TRANSCRIPT ${rows - 1}`;
		await term.waitForRender(() => screen(term).includes(last));
		return last;
	}

	async function runCommand(command: string, shown: string): Promise<void> {
		term.sendInput(command);
		await term.waitForRender(() => screen(term).some(row => row.includes(command)));
		term.sendInput("\r");
		await term.waitForRender(() => screen(term).some(row => row.includes(shown)));
	}

	function contextView(): ContextInsightsView {
		const root = mode.ui.overlayStack.at(-1)?.component.describe?.({
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		});
		const body = root?.c?.[0];
		const view = body && "k" in body ? body.c?.[0] : undefined;
		expect(view).toBeInstanceOf(ContextInsightsView);
		return view as ContextInsightsView;
	}

	function appendContextStep(index: number, promptTokens: number): string {
		return session.sessionManager.appendMessage({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			content: [
				{ type: "text", text: `PRIVATE_CONTEXT_BODY_${index}` },
				{ type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: "context-host-read.ts" } },
				{ type: "toolCall", id: `write-${index}`, name: "write", arguments: { path: "context-host-write.ts", content: "one\ntwo\n" } },
				{ type: "toolCall", id: `edit-${index}`, name: "edit", arguments: { path: "context-host-read.ts" } },
				{ type: "toolCall", id: `search-${index}`, name: "grep", arguments: { pattern: "needle", path: "context-host-read.ts" } },
			],
			usage: {
				input: promptTokens - 10,
				output: 5,
				cacheRead: 10,
				cacheWrite: 0,
				total: promptTokens + 5,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			contextSnapshot: {
				promptTokens,
				nonMessageTokens: 80,
				toolSchemaTokens: 30,
				compactionEpoch: index > 1 ? 1 : 0,
				details: {
					contextWindow: 200000,
					categories: { systemPrompt: 20, systemTools: 30, systemContext: 10, skills: 20, messages: promptTokens - 80 },
					toolSchemas: [{ name: "read", tokens: 30 }],
					skills: [{ name: "host-test", tokens: 20 }],
					systemPromptParts: [20, 10],
					systemPromptPartsOmitted: 0,
					messageCount: index,
					pendingMessageTokens: 0,
				},
			},
			stopReason: "stop",
			timestamp: Date.parse("2026-10-21T00:00:00.000Z") + index * 1000,
		});
	}

	it("focuses even a one-line interactive report full-screen over five transcript rows", async () => {
		const last = await mountTranscript(5);
		mode.showCommandReport({ title: "Interactive short report", body: new Text("SHORT_INTERACTIVE_BODY", 0, 0), interactive: true });
		await term.waitForRender(() => screen(term).some(row => row.includes("SHORT_INTERACTIVE_BODY")));
		expect(mode.ui.overlayStack).toHaveLength(1);
		expect(mode.ui.getFocused()).toBe(mode.ui.overlayStack[0]?.component ?? null);
		expect(mode.reportContainer.children).toHaveLength(0);
		expect(screen(term)).not.toContain(last);
		term.sendInput("\x1b");
		await term.waitForRender(() => screen(term).includes(last));
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(term.getScrollBuffer().some(row => Bun.stripANSI(row).includes("SHORT_INTERACTIVE_BODY"))).toBe(false);
	});

	it("opens /context as a focused four-tab page, refreshes real history, and leaves no scrollback leaks", async () => {
		const last = await mountTranscript(5);
		const before = screen(term);
		const blocks = mode.chatContainer.children.length;
		const first = appendContextStep(1, 120);
		session.sessionManager.appendCompaction("PRIVATE_COMPACTION_BODY", undefined, first, 200, { tokensAfter: 100, method: "soft" });
		session.sessionManager.appendCustomMessageEntry("system-reminder", "PRIVATE_INJECT_BODY", false);
		appendContextStep(2, 100);
		await runCommand("/context", "Full view: omp stats");

		expect(mode.ui.overlayStack).toHaveLength(1);
		expect(mode.ui.getFocused()).toBe(mode.ui.overlayStack[0]?.component ?? null);
		expect(mode.reportContainer.children).toHaveLength(0);
		expect(mode.chatContainer.children).toHaveLength(blocks);
		const overview = screen(term).join("\n");
		for (const label of ["Overview", "Trend", "Events", "Files", "Current", "Peak", "Steps", "Compactions", "Injects"]) expect(overview).toContain(label);
		expect(screen(term)).not.toContain(last);
		expect(contextView().debugState().activeTab).toBe("overview");

		term.sendInput("\t");
		await term.waitForRender(() => contextView().debugState().activeTab === "trend");
		expect(contextView().debugState().activeTab).toBe("trend");
		const trend = screen(term).join("\n");
		expect(trend).not.toBe(overview);
		term.sendInput("d");
		await term.waitForRender(() => contextView().debugState().deltaVisible);
		expect(contextView().debugState().deltaVisible).toBe(true);
		expect(screen(term).join("\n")).not.toBe(trend);

		appendContextStep(3, 9876);
		const beforeRefresh = screen(term).join("\n");
		term.sendInput("r");
		await term.waitForRender(() => screen(term).join("\n") !== beforeRefresh);
		expect(contextView().debugState()).toEqual({ activeTab: "trend", deltaVisible: true });
		expect(screen(term).join("\n")).toMatch(/9[,.]?876/);

		for (const [key, tab] of [["3", "events"], ["4", "files"], ["1", "overview"], ["2", "trend"]]) {
			term.sendInput(key!);
			await term.waitForRender(() => contextView().debugState().activeTab === tab);
			expect(contextView().debugState().activeTab).toBe(tab);
			if (tab === "files") expect(screen(term).join("\n")).toContain("context-host-read.ts");
		}
		expect(screen(term).join("\n")).not.toContain("PRIVATE_");
		term.sendInput("\x1b");
		await term.waitForRender(() => screen(term).includes(last));
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(screen(term).indexOf(last)).toBe(before.indexOf(last));
		expect(mode.chatContainer.children).toHaveLength(blocks);
		const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		expect(buffer.filter(row => row === last)).toHaveLength(1);
		for (const marker of ["Full view: omp stats", "Overview", "Context", "context-host-read.ts", "PRIVATE_"]) expect(buffer.some(row => row.includes(marker))).toBe(false);
	});

	it("opens /context without a selected model and keeps history tabs usable", async () => {
		await mountTranscript(5);
		Object.defineProperty(session.agent.state, "model", { value: undefined, writable: true, configurable: true });
		appendContextStep(1, 120);
		await runCommand("/context", "Full view: omp stats");
		expect(screen(term).join("\n")).toContain("Context usage is unavailable: no model is selected for this session.");
		expect(mode.ui.getFocused()).toBe(mode.ui.overlayStack.at(-1)?.component ?? null);
		term.sendInput("2");
		await term.waitForRender(() => contextView().debugState().activeTab === "trend");
		expect(contextView().debugState().activeTab).toBe("trend");
		expect(screen(term).join("\n")).not.toContain("No steps yet.");
		term.sendInput("\x1b");
		await term.waitForRender(() => !mode.ui.hasOverlay());
		expect(mode.ui.hasOverlay()).toBe(false);
	});

	it.each([5, 40])(
		"opens `/changelog full` as a scrollable full-screen page and Esc returns to the untouched screen (%i transcript rows)",
		async rows => {
			const last = await mountTranscript(rows);
			const before = screen(term);
			await runCommand("/changelog full", "Full Changelog");
			expect(screen(term).some(row => row.includes("PgUp/PgDn scroll"))).toBe(true);
			expect(screen(term).some(row => row.includes(last))).toBe(false);
			const page = screen(term).join("\n");
			term.sendInput("\x1b[6~");
			await term.waitForRender(() => screen(term).join("\n") !== page);
			expect(screen(term).some(row => row.includes("Full Changelog"))).toBe(true);

			term.sendInput("\x1b");
			await term.waitForRender(() => !screen(term).some(row => row.includes("Full Changelog")));
			expect(screen(term).indexOf(last)).toBe(before.indexOf(last));
			// Nothing of the page reached the main screen, and no transcript row was duplicated.
			const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			expect(buffer.filter(row => row === last)).toHaveLength(1);
			expect(buffer.some(row => row.includes("Full Changelog"))).toBe(false);
		},
	);

	it("shows a report that fits above the editor like /btw and Esc takes it away", async () => {
		const last = await mountTranscript(40);
		const lastRow = screen(term).indexOf(last);
		await runCommand("/tools", "Available Tools");
		expect(screen(term).some(row => row.includes("to close"))).toBe(true);
		// Inline: the transcript stays on the main screen, only covered from below.
		expect(screen(term).some(row => row.startsWith("TRANSCRIPT"))).toBe(true);

		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes("Available Tools")));
		expect(screen(term).indexOf(last)).toBe(lastRow);
	});

	it.each([
		["/mcp help", "MCP Server Management"],
		["/mcp list", "MCP Servers"],
		["/ssh help", "SSH Host Management"],
		["/ssh list", "SSH Hosts"],
	])("`%s` reports outside the transcript and Esc takes it away", async (command, title) => {
		const last = await mountTranscript(40);
		const lastRow = screen(term).indexOf(last);
		const blocks = mode.chatContainer.children.length;
		await runCommand(command, title);
		expect(mode.chatContainer.children).toHaveLength(blocks);

		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes(title)));
		expect(screen(term).indexOf(last)).toBe(lastRow);
		const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row));
		expect(buffer.some(row => row.includes(title))).toBe(false);
	});
});
