import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import {
	ensureChromiumExecutable,
	launchHeadlessBrowser,
	removeUserDataDir,
	type LaunchHeadlessResult,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { TempDir } from "@oh-my-pi/pi-utils";
import { contextSessionFixture } from "../../ai/test/fixtures/context-session";

const ROOT = path.resolve(import.meta.dir, "../../..");
const CLI = path.join(ROOT, "packages/coding-agent/src/cli.ts");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ENV_KEYS = [
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"PUPPETEER_EXECUTABLE_PATH",
] as const;

function cleanEnv(config: string, agent: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (key.startsWith("HERDR_") || key.startsWith("CMUX_") || key === "TERM_PROGRAM") continue;
		env[key] = value;
	}
	env.PI_CONFIG_DIR = config;
	env.PI_CODING_AGENT_DIR = agent;
	env.TERM = "xterm-256color";
	env.ANTHROPIC_API_KEY = "test-key";
	return env;
}

function strip(text: string): string {
	return Bun.stripANSI(text);
}

async function waitFor(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 20_000,
	label = "condition",
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

interface PtyHandle {
	session: PtySession;
	output: () => string;
	done: Promise<unknown>;
}

function startPty(args: string[], cwd: string, env: Record<string, string>): PtyHandle {
	const session = new PtySession();
	let raw = "";
	const done = session.startArgv(
		{ application: "bun", args, cwd, env, cols: 120, rows: 36, timeoutMs: 180_000 },
		(error, chunk) => {
			if (!error) raw += chunk;
		},
	);
	return { session, output: () => strip(raw), done };
}

async function startTui(file: string, sessionsDir: string, env: Record<string, string>): Promise<PtyHandle> {
	const handle = startPty(
		[CLI, "--model", "anthropic/claude-sonnet-4-5", "--resume", file, "--session-dir", sessionsDir],
		ROOT,
		env,
	);
	await waitFor(() => handle.output().includes("π >"), 20_000, "TUI prompt");
	await Bun.sleep(2500);
	handle.session.write("/context\r");
	await waitFor(() => handle.output().includes("1-4 jump"), 20_000, "TUI context panel");
	return handle;
}

async function appendSeventh(file: string, parentId: string): Promise<void> {
	const existing = await fs.readFile(file, "utf8");
	const entry = {
		type: "message",
		id: "a7",
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			timestamp: Date.now(),
			model: "model-b",
			provider: "test",
			content: [{ type: "text", text: "PRIVATE_LIVE_E2E_BODY" }],
			usage: { input: 140, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			stopReason: "stop",
			contextSnapshot: {
				promptTokens: 140,
				nonMessageTokens: 80,
				toolSchemaTokens: 30,
				compactionEpoch: 0,
			},
		},
	};
	await fs.writeFile(file, `${existing.trimEnd()}\n${JSON.stringify(entry)}\n`);
}

describe("context insights live source E2E", () => {
	let temp: TempDir;
	let chromium: LaunchHeadlessResult | undefined;
	let tui: PtyHandle | undefined;
	let stats: PtyHandle | undefined;
	let serverUrl = "";

	beforeAll(async () => {
		temp = TempDir.createSync("@pi-context-live-e2e-");
		const old = new Map<string, string | undefined>();
		for (const key of ENV_KEYS) old.set(key, process.env[key]);
		process.env.PI_CONFIG_DIR = temp.join("config");
		process.env.PI_CODING_AGENT_DIR = temp.join("config", "agent");
		for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "PI_SESSION_FILE", "PI_SESSION_ID"])
			delete process.env[key];
		(globalThis as { __restoreLiveEnv?: () => void }).__restoreLiveEnv = () => {
			for (const [key, value] of old) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		};
		if (!process.env.PUPPETEER_EXECUTABLE_PATH && (await Bun.file(CHROME).exists()))
			process.env.PUPPETEER_EXECUTABLE_PATH = CHROME;
		const executable = await ensureChromiumExecutable();
		if (!executable) throw new Error("Context live E2E requires launchable headless Chromium");
		chromium = await launchHeadlessBrowser({ headless: true, viewport: { width: 1440, height: 900 } });
	}, 120_000);

	afterAll(async () => {
		tui?.session.kill();
		stats?.session.kill();
		try {
			await chromium?.browser.close();
		} finally {
			if (chromium?.userDataDir) await removeUserDataDir(chromium.userDataDir);
			(globalThis as { __restoreLiveEnv?: () => void }).__restoreLiveEnv?.();
			temp?.removeSync();
		}
	});

	it("observes TUI and already-open Web detail both refresh from six to seven steps", async () => {
		const fixture = contextSessionFixture();
		const sessionsDir = path.join(temp.path(), "config", "agent", "sessions", "data");
		const file = path.join(sessionsDir, "--context-live--", "live.jsonl");
		await fs.mkdir(path.dirname(file), { recursive: true });
		const header = {
			type: "session",
			version: 3,
			id: "context-live-session",
			timestamp: new Date().toISOString(),
			cwd: ROOT,
		};
		await fs.writeFile(file, `${[header, ...fixture.branch].map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const env = cleanEnv(temp.join("config"), path.join(temp.path(), "config", "agent"));

		tui = await startTui(file, sessionsDir, env);
		expect(tui.output()).toMatch(/Steps\s+6/);

		const port = 4300 + Math.floor(Math.random() * 200);
		stats = startPty([CLI, "stats", "-p", String(port), "--host", "127.0.0.1"], ROOT, env);
		serverUrl = `http://127.0.0.1:${port}`;
		await waitFor(
			async () => {
				try {
					return (await fetch(`${serverUrl}/api/context/overview?range=24h`)).ok;
				} catch {
					return false;
				}
			},
			30_000,
			"stats server",
		);

		const page = await chromium!.browser.newPage();
		try {
			await page.goto(`${serverUrl}/#/context?range=24h&s=${encodeURIComponent(file)}`, {
				waitUntil: "networkidle2",
			});
			await page.waitForSelector('[data-testid="context-detail-requests"]');
			expect(await page.$eval('[data-testid="context-detail-requests"]', element => element.textContent)).toBe("6");
			await page.click('[data-testid="context-tab-trend"]');
			const delta = (await page.$$(".context-trend .segmented-option"))[1];
			if (!delta) throw new Error("Web delta toggle missing");
			await delta.click();

			tui.session.kill();
			await tui.done.catch(() => {});
			await appendSeventh(file, "a6");
			tui = await startTui(file, sessionsDir, env);
			tui.session.write("\t");
			await waitFor(() => tui!.output().includes("#6"), 10_000, "TUI Trend");
			tui.session.write("d");
			await waitFor(() => /#6.*140.*Δ \+120/.test(tui!.output()), 20_000, "TUI source CLI reads seven");
			await waitFor(
				async () =>
					(await page.$eval('[data-testid="context-detail-requests"]', element => element.textContent)) === "7",
				25_000,
				"Web refresh to seven",
			);
			await page.waitForFunction('document.querySelector("body")?.textContent?.includes("+120")', {
				timeout: 20_000,
			});
			expect(await page.$eval("body", element => element.textContent)).toContain("#6");
			expect(await page.$eval("body", element => element.textContent)).not.toContain("PRIVATE_LIVE_E2E_BODY");
		} finally {
			await page.close();
		}
	}, 240_000);
});
