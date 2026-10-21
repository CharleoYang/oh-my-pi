import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb } from "@oh-my-pi/omp-stats/db";
import { refreshRollups } from "@oh-my-pi/omp-stats/rollup";
import { startServer, type StatsServerHandle } from "@oh-my-pi/omp-stats/server";
import type { ContextOverview } from "@oh-my-pi/omp-stats/shared-types";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ContextJournalEntry, ContextTimeline } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	ensureChromiumExecutable,
	launchHeadlessBrowser,
	removeUserDataDir,
	type LaunchHeadlessResult,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	getPuppeteerDir,
	getSessionsDir,
	getStatsDbPath,
	setAgentDir,
	TempDir,
} from "@oh-my-pi/pi-utils";
import { expectContextTimelineParity } from "../../ai/test/context-insights-assertions";
import { contextSessionFixture } from "../../ai/test/fixtures/context-session";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Source-only gate: never execute/link/install this binary. Replacement requires explicit user approval.
const INSTALLED_OMP = "/opt/homebrew/bin/omp";
async function installedFingerprint() {
	try {
		const stat = await fs.stat(INSTALLED_OMP);
		return {
			mtimeMs: stat.mtimeMs,
			hash: new Bun.CryptoHasher("sha256").update(await Bun.file(INSTALLED_OMP).arrayBuffer()).digest("hex"),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

const ENV_KEYS = [
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"PUPPETEER_EXECUTABLE_PATH",
] as const;

describe("context insights source-only cross-surface E2E", () => {
	let temp: TempDir;
	let installedBefore: { mtimeMs: number; hash: string } | null;
	const oldEnv = new Map<string, string | undefined>();
	let chromium: LaunchHeadlessResult | undefined;

	beforeAll(async () => {
		installedBefore = await installedFingerprint();
		temp = TempDir.createSync("@pi-context-e2e-");
		for (const key of ENV_KEYS) oldEnv.set(key, process.env[key]);
		for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "PI_SESSION_FILE", "PI_SESSION_ID"])
			delete process.env[key];
		process.env.PI_CONFIG_DIR = path.relative(os.homedir(), temp.join("config"));
		setAgentDir(temp.join("config", "agent"));
		for (const directory of [getAgentDir(), getPuppeteerDir(), getSessionsDir(), getStatsDbPath()]) {
			expect(directory.startsWith(temp.path() + path.sep)).toBe(true);
		}
		initTheme();
		const errors: string[] = [];
		let executable: string | undefined;
		const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		// Reuse an installed browser read-only; all browser profile writes remain temporary.
		if (!process.env.PUPPETEER_EXECUTABLE_PATH && (await Bun.file(systemChrome).exists())) {
			process.env.PUPPETEER_EXECUTABLE_PATH = systemChrome;
		}
		try {
			executable = await ensureChromiumExecutable();
		} catch (error) {
			errors.push(`ensureChromiumExecutable: ${String(error)}`);
		}
		const candidates = [...new Set([executable, systemChrome].filter((value): value is string => Boolean(value)))];
		for (const candidate of candidates) {
			try {
				await fs.access(candidate);
				process.env.PUPPETEER_EXECUTABLE_PATH = candidate;
				chromium = await launchHeadlessBrowser({ headless: true, viewport: { width: 1440, height: 900 } });
				break;
			} catch (error) {
				errors.push(`${candidate}: ${String(error)}`);
			}
		}
		if (!chromium)
			throw new Error(
				`Context E2E requires launchable headless Chromium. Install Chrome or set PUPPETEER_EXECUTABLE_PATH.\n${errors.join("\n")}`,
			);
	}, 180000);

	afterAll(async () => {
		try {
			try {
				await chromium?.browser.close();
			} finally {
				if (chromium?.userDataDir) await removeUserDataDir(chromium.userDataDir);
			}
		} finally {
			closeDb();
			for (const [key, value] of oldEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			__resetDirsFromEnvForTests();
			temp?.removeSync();
			resetSettingsForTest();
			expect(await installedFingerprint()).toEqual(installedBefore);
		}
	});

	it("opens /context in a real terminal and conserves the same journal through HTTP and Chromium", async () => {
		let mode: InteractiveMode | undefined;
		let session: AgentSession | undefined;
		let auth: AuthStorage | undefined;
		let server: StatsServerHandle | undefined;
		const page = await chromium!.browser.newPage();
		try {
			const cwd = temp.join("project");
			await fs.mkdir(cwd, { recursive: true });
			expect(getSessionsDir().startsWith(temp.path() + path.sep)).toBe(true);
			expect(getStatsDbPath().startsWith(temp.path() + path.sep)).toBe(true);
			const file = path.join(getSessionsDir(), "--context-e2e--", "context-parity.jsonl");
			await fs.mkdir(path.dirname(file), { recursive: true });
			const now = new Date().toISOString();
			const fixture = contextSessionFixture();
			// The fixture's id-less title represents a fixed title slot, not a branch entry.
			// Keep the session header first and write only actual journal records here.
			const entries = fixture.entries
				.filter(entry => entry.type !== "title")
				.map((entry: ContextJournalEntry) => ({
					...entry,
					timestamp: now,
					...(entry.type === "session" ? { version: 3, cwd } : {}),
					...(entry.message
						? {
								message: {
									...entry.message,
									...(entry.message.role === "assistant"
										? { api: "anthropic-messages", stopReason: "stop" }
										: {}),
									timestamp: Date.parse(now),
									content: entry.message.content ?? [],
								},
							}
						: {}),
				}));
			await Bun.write(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
			resetSettingsForTest();
			await Settings.init({ inMemory: true, cwd });
			auth = await AuthStorage.create(temp.join("testauth.db"));
			const registry = new ModelRegistry(auth);
			const model = registry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 in model registry");
			const manager = await SessionManager.open(file, path.dirname(file), undefined, {
				initialCwd: cwd,
				suppressBreadcrumb: true,
			});
			session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated(),
				modelRegistry: registry,
			});
			const terminal = new VirtualTerminal(120, 36);
			mode = new InteractiveMode(
				session,
				"test",
				undefined,
				() => {},
				undefined,
				undefined,
				undefined,
				new Composer({ terminal }),
			);
			await mode.init({ suppressWelcomeIntro: true });
			void mode.getUserInput();
			const screen = () =>
				terminal
					.getViewport()
					.map(row => Bun.stripANSI(row))
					.join("\n");
			await terminal.waitForRender();
			terminal.sendInput("/context");
			await terminal.waitForRender(() => screen().includes("/context"));
			terminal.sendInput("\r");
			await terminal.waitForRender(() => screen().includes("1-4 jump"));
			for (const title of ["Overview", "Trend", "Events", "Files"]) expect(screen()).toContain(title);
			expect(mode.ui.getFocused()).toBe(mode.ui.overlayStack.at(-1)?.component ?? null);
			let live = session.getContextTimeline();
			expect(live.steps.map(step => step.promptTokens)).toEqual([120, 100, 80, 60, 40, 20]);
			expect(live.peakTokens).toBe(120);
			expect(screen()).toMatch(/Steps\s+6/);
			expect(screen()).toMatch(/Peak\s+120/);
			terminal.sendInput("\t");
			await terminal.waitForRender(() => screen().includes("#1"));
			terminal.sendInput("d");
			await terminal.waitForRender(() => screen().includes("Δ"));
			expect(screen()).toContain("Δ");
			manager.appendMessage({
				role: "assistant",
				api: "anthropic-messages",
				provider: "test",
				model: "model-b",
				content: [{ type: "text", text: "PRIVATE_E2E_ASSISTANT_BODY" }],
				usage: {
					input: 140,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 145,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
				contextSnapshot: {
					promptTokens: 140,
					nonMessageTokens: 80,
					toolSchemaTokens: 30,
					compactionEpoch: 0,
					details: live.steps[0]!.details,
				},
			});
			await manager.flush();
			terminal.sendInput("r");
			await terminal.waitForRender(() => screen().includes("Δ +120"));
			expect(screen()).toMatch(/#6.*140.*Δ \+120/);
			live = session.getContextTimeline();
			expect(live.steps).toHaveLength(7);
			expect(live.steps.at(-1)?.deltaTokens).toBe(120);
			terminal.sendInput("3");
			await terminal.waitForRender(() => screen().includes("fixture-rule"));
			expect(screen()).toContain("fixture-rule");
			terminal.sendInput("4");
			await terminal.waitForRender(() => screen().includes("pending.ts"));
			expect(screen()).toContain("pending.ts");
			expect(screen()).not.toContain("PRIVATE_E2E_ASSISTANT_BODY");
			terminal.sendInput("\x1b");
			await terminal.waitForRender(() => !screen().includes("1-4 jump"));
			expect(mode.ui.hasOverlay()).toBe(false);
			expect(mode.ui.getFocused()).toBe(mode.editor);

			server = await startServer(0, "127.0.0.1");
			await syncAllSessions();
			await refreshRollups();
			const base = `http://127.0.0.1:${server.port}`;
			const url = `${base}/api/session/context?${new URLSearchParams({ file })}`;
			const response = await fetch(url);
			expect(response.status).toBe(200);
			const etag = response.headers.get("ETag");
			expect(etag).toBeTruthy();
			const journal = (await response.json()) as ContextTimeline;
			expectContextTimelineParity(journal, live, { ignoreAgents: true, ignoreSource: true, ignoreFile: true });
			const unchanged = await fetch(url, { headers: { "If-None-Match": etag! } });
			expect(unchanged.status).toBe(304);
			expect(await unchanged.text()).toBe("");
			expect(JSON.stringify(journal)).not.toContain("PRIVATE_E2E_ASSISTANT_BODY");
			expect(journal.steps.length).toBeLessThanOrEqual(1000);
			expect(journal.events.length).toBeLessThanOrEqual(200);
			expect(journal.files.length).toBeLessThanOrEqual(500);
			expect(
				journal.steps.reduce(
					(sum, step) =>
						sum +
						(step.details?.toolSchemas?.length ?? 0) +
						(step.details?.skills?.length ?? 0) +
						(step.details?.systemPromptParts?.length ?? 0),
					0,
				),
			).toBeLessThanOrEqual(500);
			const overviewResponse = await fetch(`${base}/api/context/overview?range=24h`);
			expect(overviewResponse.status).toBe(200);
			const overview = (await overviewResponse.json()) as ContextOverview;
			expect(overview.sessions.some(row => row.file === file)).toBe(true);
			expect(overview.heatmap.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(overview.kpi.requests);
			expect(overview.sessions.reduce((sum, row) => sum + row.requests, 0) + overview.omittedRequests).toBe(
				overview.kpi.requests,
			);
			expect(overview.heatmap.reduce((sum, bucket) => sum + bucket.promptTokens, 0)).toBe(
				overview.sessions.reduce((sum, row) => sum + row.promptTokens, 0) + overview.omittedPromptTokens,
			);

			const browserErrors: string[] = [];
			page.on("pageerror", error => browserErrors.push(String(error)));
			// The dashboard keeps /api/events open; zero in-flight requests is never reached.
			await page.goto(`${base}/#/context?range=24h`, { waitUntil: "networkidle2" });
			await page.waitForSelector('[data-testid="context-kpi-requests"]');
			expect(await page.$eval('[data-testid="context-kpi-requests"]', element => element.textContent)).toContain(
				String(overview.kpi.requests),
			);
			await page.waitForSelector(".context-session-card");
			await page.click(".context-session-card");
			await page.waitForSelector('[data-testid="context-detail-requests"]');
			const detailUrl = page.url();
			expect(await page.$eval('[data-testid="context-detail-requests"]', element => element.textContent)).toBe(
				String(live.steps.length),
			);
			expect(await page.$eval('[data-testid="context-detail-peak"]', element => element.textContent)).toBe(
				String(live.peakTokens),
			);
			await page.click('[data-testid="context-tab-trend"]');
			await page.waitForSelector('[data-testid="context-tab-trend"][aria-selected="true"]');
			const trendOptions = await page.$$(".context-trend .segmented-option");
			const deltaToggle = trendOptions[1];
			if (!deltaToggle) throw new Error("Web Trend delta toggle missing");
			await deltaToggle.click();
			await page.waitForFunction('document.querySelector("body")?.textContent?.includes("+120")');
			const trendText = await page.$eval("body", element => element.textContent ?? "");
			expect(trendText).toContain("#6");
			expect(trendText).toContain("+120");

			for (const tab of ["composition", "trend", "browser", "events", "files", "fleet"]) {
				const selector = `[data-testid="context-tab-${tab}"]`;
				expect(await page.$eval(selector, element => element.textContent)).toBe(
					tab[0]!.toUpperCase() + tab.slice(1),
				);
				await page.click(selector);
				await page.waitForSelector(`${selector}[aria-selected="true"]`);
				expect(new URLSearchParams(page.url().split("?")[1]).get("s")).toBe(file);
				expect(await page.$eval("body", element => element.textContent)).not.toContain(
					"PRIVATE_E2E_ASSISTANT_BODY",
				);
			}
			await page.click('[data-testid="context-tab-files"]');
			await page.waitForSelector(".context-file-activity");
			expect(await page.$eval(".context-file-activity", element => element.getAttribute("aria-label"))).toContain(
				"reads",
			);
			await page.click('[data-testid="context-tab-fleet"]');
			await page.waitForSelector('[data-testid="fleet-graph"]');
			expect(await page.$$eval('[data-testid="fleet-main"]', elements => elements.length)).toBe(1);
			await page.click('[data-testid="context-tab-browser"]');
			const toTrend = await page.$("xpath/.//button[normalize-space()='Open in Trend']");
			if (!toTrend) throw new Error("Browser Open in Trend missing");
			await toTrend.click();
			await page.waitForSelector('[data-testid="context-tab-trend"][aria-selected="true"]');
			for (const action of ["click", "Enter", "Space"] as const) {
				const controlPage = await chromium!.browser.newPage();
				try {
					await controlPage.goto(detailUrl, { waitUntil: "networkidle2" });
					await controlPage.waitForSelector('[data-testid="context-detail-requests"]');
					await controlPage.click('[data-testid="context-tab-files"]');
					await controlPage.waitForSelector('[data-testid="context-tab-files"][aria-selected="true"]');
					await controlPage.waitForSelector(".context-file-open");
					await controlPage.evaluate(() => {
						const browser = globalThis as unknown as {
							__hash: number;
							addEventListener: (type: string, listener: () => void) => void;
						};
						browser.__hash = 0;
						browser.addEventListener("hashchange", () => {
							browser.__hash++;
						});
					});
					const button = await controlPage.$(".context-file-open");
					if (!button) throw new Error("open trace button missing");
					if (action === "click") await button.click();
					else {
						await button.focus();
						await controlPage.keyboard.press(action);
					}
					await controlPage.waitForFunction(() =>
						(
							globalThis as unknown as {
								location: { hash: string };
							}
						).location.hash.includes("/traces"),
					);
					await Bun.sleep(150);
					expect(await controlPage.evaluate(() => (globalThis as unknown as { __hash: number }).__hash)).toBe(1);
				} finally {
					await controlPage.close();
				}
			}
			const screenshotPath = temp.join("context-insights.png");
			await page.screenshot({ path: screenshotPath, fullPage: true });
			const evidenceDir = process.env.CONTEXT_E2E_EVIDENCE_DIR;
			if (evidenceDir) {
				await fs.mkdir(evidenceDir, { recursive: true });
				await fs.copyFile(screenshotPath, path.join(evidenceDir, "context-insights.png"));
			}
			expect(browserErrors).toEqual([]);
		} catch (error) {
			const browserState = { url: page.url(), text: await page.$eval("body", element => element.textContent) };
			throw new Error(`${String(error)}\nBrowser state: ${JSON.stringify(browserState)}`, { cause: error });
		} finally {
			try {
				await page.close();
			} finally {
				server?.stop();
				closeDb();
				mode?.stop();
				try {
					await session?.dispose();
				} finally {
					auth?.close();
				}
			}
		}
	}, 180000);
});
