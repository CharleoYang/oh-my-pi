import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDisplayFocusMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function harness() {
	const settings = Settings.isolated();
	const showStatus = vi.fn();
	const setText = vi.fn();
	const runtime = { ctx: { settings, showStatus, editor: { setText } } } as never;
	return { settings, showStatus, setText, runtime };
}

describe("/focus slash command", () => {
	it("is advertised in the command list", () => {
		expect(BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "focus")?.description).toContain(
			"hide tool activity",
		);
	});

	it("toggles focus mode on and off through the display setting", async () => {
		const h = harness();
		expect(cfgDisplayFocusMode.get(h.settings)).toBe(false);

		await executeBuiltinSlashCommand("/focus", h.runtime);
		expect(cfgDisplayFocusMode.get(h.settings)).toBe(true);
		expect(h.showStatus).toHaveBeenLastCalledWith(
			"Focus mode on — prompts, final answers, and an activity summary only",
		);

		await executeBuiltinSlashCommand("/focus", h.runtime);
		expect(cfgDisplayFocusMode.get(h.settings)).toBe(false);
		expect(h.showStatus).toHaveBeenLastCalledWith("Focus mode off — full transcript restored");
		expect(h.setText).toHaveBeenCalledWith("");
	});
});
