// Fork divergence: the whitespace-delta breaker limits are env-configurable
// (PI_CODEX_WHITESPACE_DELTA_EVENT_LIMIT / PI_CODEX_WHITESPACE_DELTA_CHAR_LIMIT)
// so internal gateways that keep streams alive with short whitespace deltas can
// raise the breaker. A developer shell exporting those vars would otherwise
// leak into the test process and stall upstream's breaker tests, which assume
// the official defaults. Scrub them before the provider module evaluates its
// top-level constants (this module must be imported first).
delete process.env.PI_CODEX_WHITESPACE_DELTA_EVENT_LIMIT;
delete process.env.PI_CODEX_WHITESPACE_DELTA_CHAR_LIMIT;
