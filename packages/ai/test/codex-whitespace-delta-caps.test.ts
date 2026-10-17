import { describe, expect, it } from "bun:test";
import { resolveCodexWhitespaceDeltaCaps } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";

const DEFAULTS = { events: 256, chars: 16 * 1024 };

describe("Codex whitespace-delta caps", () => {
	it("keeps the shipped defaults when neither cap is configured", () => {
		expect(resolveCodexWhitespaceDeltaCaps({})).toEqual(DEFAULTS);
	});

	it("honors both overrides", () => {
		expect(
			resolveCodexWhitespaceDeltaCaps({
				PI_CODEX_WHITESPACE_DELTA_EVENT_LIMIT: "4096",
				PI_CODEX_WHITESPACE_DELTA_CHAR_LIMIT: "1048576",
			}),
		).toEqual({ events: 4096, chars: 1048576 });
	});

	it("ignores values that are not whole positive decimal integers", () => {
		// `parseInt` would read `1e3` as 1 and `12abc` as 12, silently shrinking the
		// cap instead of leaving the shipped one in place.
		for (const value of ["", " ", "0", "-5", "1e3", "12abc", "0x20", "Infinity"]) {
			expect(
				resolveCodexWhitespaceDeltaCaps({
					PI_CODEX_WHITESPACE_DELTA_EVENT_LIMIT: value,
					PI_CODEX_WHITESPACE_DELTA_CHAR_LIMIT: value,
				}),
			).toEqual(DEFAULTS);
		}
	});
});
