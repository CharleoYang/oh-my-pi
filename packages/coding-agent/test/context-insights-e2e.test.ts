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
import type { ContextTimeline } from "@oh-my-pi/pi-ai";
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
import { getAgentDir, getSessionsDir, getStatsDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { contextSessionFixture } from "../../ai/test/fixtures/context-session";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Source-only gate: never execute/link/install this binary. Replacement requires explicit user approval.
const INSTALLED_OMP = "/opt/homebrew/bin/omp";
async function installedFingerprint() {
	try {
		const stat = await fs.stat(INSTALLED_OMP);
		return { mtimeMs: stat.mtimeMs, hash: new Bun.CryptoHasher("sha256").update(await Bun.file(INSTALLED_OMP).arrayBuffer()).digest("hex") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

const ENV_KEYS = ["PI_CONFIG_DIR", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "PUPPETEER_EXECUTABLE_PATH"] as const;

describe("context insights source-only cross-surface E2E", () => {
	let temp: TempDir;
	let oldAgentDir: string;
	let installedBefore: { mtimeMs: number; hash: string } | null;
	const oldEnv = new Map<string, string | undefined>();
	let chromium: LaunchHeadlessResult | undefined;

	beforeAll(async () => {
		installedBefore = await installedFingerprint();
		oldAgentDir = getAgentDir();
		temp = TempDir.createSync("@pi-context-e2e-");
		for (const key of ENV_KEYS) oldEnv.set(key, process.env[key]);
		for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[key];
		process.env.PI_CONFIG_DIR = path.relative(os.homedir(), temp.join("config"));
		setAgentDir(temp.join("config", "agent"));
		initTheme();
		const errors: string[] = [];
		let executable: string | undefined;
		const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		// Reuse an installed browser read-only; all browser profile writes remain temporary.
		if (!process.env.PUPPETEER_EXECUTABLE_PATH && await Bun.file(systemChrome).exists()) {
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
		if (!chromium) throw new Error(`Context E2E requires launchable headless Chromium. Install Chrome or set PUPPETEER_EXECUTABLE_PATH.\n${errors.join("\n")}`);
	}, 180000);

	afterAll(async () => {
		try {
			await chromium?.browser.close();
			if (chromium?.userDataDir) await removeUserDataDir(chromium.userDataDir);
		} finally {
			closeDb();
			for (const [key, value] of oldEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			if (oldAgentDir) setAgentDir(oldAgentDir);
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
			const entries = fixture.entries.map(entry => ({
				...entry,
				timestamp: now,
				...(entry.type === "session" ? { version: 3, cwd } : {}),
				...(entry.message ? { message: { ...entry.message, timestamp: Date.parse(now), content: entry.message.content ?? [] } } : {}),
			}));
			await Bun.write(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
			resetSettingsForTest();
			await Settings.init({ inMemory: true, cwd });
			auth = await AuthStorage.create(temp.join("testauth.db"));
			const registry = new ModelRegistry(auth);
			const model = registry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 in model registry");
			const manager = await SessionManager.open(file, path.dirname(file), undefined, { initialCwd: cwd, suppressBreadcrumb: true });
			session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: manager,
				settings: Settings.isolated(),
				modelRegistry: registry,
			});
			const terminal = new VirtualTerminal(120, 36);
			mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, new Composer({ terminal }));
			await mode.init({ suppressWelcomeIntro: true });
			void mode.getUserInput();
			const screen = () => terminal.getViewport().map(row => Bun.stripANSI(row)).join("\n");
			await terminal.waitForRender();
			terminal.sendInput("/context\r");
			await terminal.waitForRender(() => screen().includes("1-4 jump"));
			for (const title of ["Overview", "Trend", "Events", "Files"]) expect(screen()).toContain(title);
			const live = session.getContextTimeline();
			expect(live.steps.map(step => step.promptTokens)).toEqual([120, 100, 80, 60, 40, 20]);
			expect(live.peakTokens).toBe(120);
			expect(screen()).toMatch(/Steps\s+6/);
			expect(screen()).toMatch(/Peak\s+120/);
			terminal.sendInput("\t");
			await terminal.waitForRender(() => screen().includes("#1"));
			terminal.sendInput("d");
			await terminal.waitForRender(() => screen().includes("Δ"));
			terminal.sendInput("3");
			await terminal.waitForRender(() => screen().includes("fixture-rule"));
			terminal.sendInput("4");
			await terminal.waitForRender(() => screen().includes("pending.ts"));
			terminal.sendInput("\x1b");
			await terminal.waitForRender(() => !screen().includes("1-4 jump"));

			server = await startServer(0, "127.0.0.1");
			await syncAllSessions();
			await refreshRollups();
			const base = `http://127.0.0.1:${server.port}`;
			const url = `${base}/api/session/context?${new URLSearchParams({ file })}`;
			const response = await fetch(url);
			expect(response.status).toBe(200);
			const etag = response.headers.get("ETag");
			expect(etag).toBeTruthy();
			const journal = await response.json() as ContextTimeline;
			for (const key of ["steps", "events", "files", "peakTokens", "legacySteps", "incompleteFileCalls"] as const) expect(journal[key]).toEqual(live[key]);
			const unchanged = await fetch(url, { headers: { "If-None-Match": etag! } });
			expect(unchanged.status).toBe(304);
			expect(await unchanged.text()).toBe("");
			expect(journal.steps.length).toBeLessThanOrEqual(1000);
			expect(journal.events.length).toBeLessThanOrEqual(200);
			expect(journal.files.length).toBeLessThanOrEqual(500);
			expect(journal.steps.reduce((sum, step) => sum + (step.details ? step.details.toolSchemas.length + step.details.skills.length + step.details.systemPromptParts.length : 0), 0)).toBeLessThanOrEqual(500);
			const overviewResponse = await fetch(`${base}/api/context/overview?range=24h`);
			expect(overviewResponse.status).toBe(200);
			const overview = await overviewResponse.json() as ContextOverview;
			expect(overview.sessions.some(row => row.file === file)).toBe(true);
			expect(overview.heatmap.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(overview.kpi.requests);
			expect(overview.sessions.reduce((sum, row) => sum + row.requests, 0) + overview.omittedRequests).toBe(overview.kpi.requests);
			expect(overview.heatmap.reduce((sum, bucket) => sum + bucket.promptTokens, 0)).toBe(overview.sessions.reduce((sum, row) => sum + row.promptTokens, 0) + overview.omittedPromptTokens);

			const browserErrors: string[] = [];
			page.on("pageerror", error => browserErrors.push(String(error)));
			await page.goto(`${base}/#/context?range=24h`, { waitUntil: "networkidle0" });
			await page.waitForSelector('[data-testid="context-kpi-requests"]');
			expect(await page.$eval('[data-testid="context-kpi-requests"]', element => element.textContent)).toContain(String(overview.kpi.requests));
			await page.waitForSelector(".context-page .table tbody tr");
			await page.click(".context-page .table tbody tr");
			await page.waitForSelector('[data-testid="context-detail-requests"]');
			expect(await page.$eval('[data-testid="context-detail-requests"]', element => element.textContent)).toBe(String(live.steps.length));
			expect(await page.$eval('[data-testid="context-detail-peak"]', element => element.textContent)).toBe(String(live.peakTokens));
			for (const tab of ["composition", "trend", "browser", "events", "files", "fleet"]) {
				const selector = `[data-testid="context-tab-${tab}"]`;
				expect(await page.$eval(selector, element => element.textContent)).toBe(tab[0]!.toUpperCase() + tab.slice(1));
				await page.click(selector);
				await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute("aria-selected") === "true", {}, selector);
				expect(new URLSearchParams((await page.evaluate(() => location.hash)).split("?")[1]).get("s")).toBe(file);
			}
			await page.screenshot({ path: temp.join("context-insights.png"), fullPage: true });
			expect(browserErrors).toEqual([]);
		} finally {
			await page.close();
			server?.stop();
			closeDb();
			mode?.stop();
			await session?.dispose();
			auth?.close();
		}
	}, 180000);
});
