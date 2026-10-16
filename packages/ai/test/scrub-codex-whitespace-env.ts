// The whitespace-delta caps are environment-configurable
// (`PI_CODEX_WHITESPACE_DELTA_EVENT_LIMIT` / `PI_CODEX_WHITESPACE_DELTA_CHAR_LIMIT`).
// A shell that exports either one would otherwise leak into the test process and
// stall the breaker tests below, which assert the shipped defaults. Import this
// module first: the provider reads both caps when its module is evaluated.
delete process.env.PI_CODEX_WHITESPACE_DELTA_EVENT_LIMIT;
delete process.env.PI_CODEX_WHITESPACE_DELTA_CHAR_LIMIT;
