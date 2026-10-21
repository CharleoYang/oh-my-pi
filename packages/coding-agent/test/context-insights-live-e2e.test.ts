import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
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
		[CLI, "--model", "mock/mock-model", "--resume", file, "--session-dir", sessionsDir],
		ROOT,
		env,
	);
	await waitFor(() => handle.output().includes("π >"), 20_000, "TUI prompt");
	await Bun.sleep(2000);
	handle.session.write("/context\r");
	await waitFor(() => handle.output().includes("1-4 jump"), 20_000, "TUI context panel");
	return handle;
}

function mockProvider(): { server: ReturnType<typeof Bun.serve>; url: string } {
	const payload = [
		`data: ${JSON.stringify({
			id: "chatcmpl-live",
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "mock-model",
			choices: [{ index: 0, delta: { role: "assistant", content: "done from mock" }, finish_reason: null }],
		})}\n\n`,
		`data: ${JSON.stringify({
			id: "chatcmpl-live",
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "mock-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
		})}\n\n`,
		"data: [DONE]\n\n",
	].join("");
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const body = await request.json().catch(() => undefined);
			if (body && typeof body === "object" && "stream" in body && body.stream === false) {
				return Response.json({
					id: "chatcmpl-live",
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: "mock-model",
					choices: [
						{ index: 0, message: { role: "assistant", content: "done from mock" }, finish_reason: "stop" },
					],
					usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
				});
			}
			return new Response(payload, { headers: { "content-type": "text/event-stream" } });
		},
	});
	return { server, url: `http://127.0.0.1:${server.port}/v1` };
}

describe("context insights live source E2E", () => {
	let temp: TempDir;
	let chromium: LaunchHeadlessResult | undefined;
	let tui: PtyHandle | undefined;
	let stats: PtyHandle | undefined;
	let mock: ReturnType<typeof mockProvider> | undefined;

	beforeAll(async () => {
		temp = TempDir.createSync("@pi-context-live-e2e-");
		mock = mockProvider();
		const config = temp.join("config");
		const agent = path.join(config, "agent");
		await fs.mkdir(agent, { recursive: true });
		await fs.writeFile(
			path.join(agent, "models.yml"),
			`providers:\n  mock:\n    baseUrl: ${mock.url}\n    api: openai-completions\n    apiKey: test\n    models:\n      - id: mock-model\n        name: Mock Model\n        input: [text]\n        contextWindow: 200000\n        maxTokens: 4096\n`,
		);
		process.env.PI_CONFIG_DIR = config;
		process.env.PI_CODING_AGENT_DIR = agent;
		for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "PI_SESSION_FILE", "PI_SESSION_ID"])
			delete process.env[key];
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
			mock?.server.stop(true);
			temp?.removeSync();
		}
	});

	it("reaches seven steps in one live TUI turn and an already-open Web detail", async () => {
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
		tui.session.write("\x1b");
		await waitFor(() => !tui!.output().split("\n").at(-1)?.includes("1-4 jump"), 5_000, "TUI panel close");

		const port = 4300 + Math.floor(Math.random() * 200);
		stats = startPty([CLI, "stats", "-p", String(port), "--host", "127.0.0.1"], ROOT, env);
		const serverUrl = `http://127.0.0.1:${port}`;
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

			tui.session.write("say done\r");
			await waitFor(() => tui!.output().includes("done from mock"), 30_000, "TUI live turn");
			tui.session.write("/context\r");
			await waitFor(() => tui!.output().includes("1-4 jump"), 10_000, "TUI reopen context");
			await waitFor(() => /Steps\s+7/.test(tui!.output()), 10_000, "TUI seven steps");
			tui.session.write("\t");
			await waitFor(() => tui!.output().includes("#6"), 10_000, "TUI Trend");
			tui.session.write("d");
			await waitFor(() => /#6.*100.*Δ \+80/.test(tui!.output()), 20_000, "TUI delta +80");

			await waitFor(
				async () =>
					(await page.$eval('[data-testid="context-detail-requests"]', element => element.textContent)) === "7",
				25_000,
				"Web refresh to seven",
			);
			await page.waitForFunction('document.querySelector("body")?.textContent?.includes("+80")', {
				timeout: 20_000,
			});
			expect(await page.$eval("body", element => element.textContent)).toContain("#6");
			expect(await page.$eval("body", element => element.textContent)).not.toContain("done from mock");
		} finally {
			await page.close();
		}
	}, 240_000);
});
