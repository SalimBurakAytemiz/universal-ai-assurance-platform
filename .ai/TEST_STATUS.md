# TEST STATUS

Recorded from ACTUAL local runs (never hand-written as "pass").

## Last local run — 2026-10-06 (branch auto/quality-web-engine)

Command: `npm run verify` (validate → typecheck → test)

- validate: **OK** (policies, build graph, agents, skills, adapters, domains, knowledge, state)
- typecheck (`tsc --noEmit`): **OK**
- vitest: **450 passed / 450** across 36 files (+ quality-web-engine functional web-flow engine, review rounds 1-4 fixes)

New this change — `@uaap/quality-web-engine` (`packages/quality-web-engine/test/`): **9 tests**
- Functional web/UI assurance on the @uaap/engine-core lifecycle over RECORDED web-interaction
  artifacts (ordered flow of steps: URL reached, required/forbidden elements, console, network).
  Scope DISTINCT from accessibility (WCAG snapshots), api (contracts), performance (budgets).
- Checks: navigation correctness (expected-URL exact + prefix glob, query-stripped), navigation
  error status, required-element presence/visibility, forbidden-element (error-state) presence,
  console errors (level only), network failures (status/failed/not-ok), recorded step outcome.
- OFFLINE-ONLY / no Agent→Target (live Playwright capture is a gated tool-broker adapter, not here).
- FAIL-CLOSED / NO FAKE GREEN: an unrecorded required element = `requirement-unverifiable`, an
  expected URL with no recorded actual = `navigation-unverifiable` (never a silent pass); malformed
  flow/step/entry surfaced per-item, never crashes the run; duplicate flow id keeps the first.
- SECRET-SAFE BY CONSTRUCTION: URLs echoed with query + fragment stripped (token/PII live there);
  console/request bodies never echoed — only levels, statuses, methods, counts. Test asserts a
  planted `token=SECRET123&pii=alice@example.test` URL and a console body never appear in findings.

Prior merged work (unchanged): the full core, the execution-engine layer (api, database, realtime,
performance, accessibility), the security appsec detection engine, the knowledge graph, the
research-intelligence pipeline, the autopilot durability chain, and the desktop real-state
view-model data layer are all IMPLEMENTED+TESTED and merged (PRs #2–#20).

Adversarial review round 1 (PR #21, 24 agents) confirmed 7 defects — ALL fixed with regression
tests: 2×P1 (network ok:false with a non-5xx status silently passed; safeUrl leaked basic-auth
userinfo credentials), 4×P2/P3 false-negatives + fail-closed gaps (required/forbidden element with
null/non-boolean/unrecorded `present` silently passed; throwing flow-identity getter aborted the
whole run; benign console allowlist flagged standard console.table/dir/group types; step-level
cancellation checkpoint). Round 2 (11 agents) confirmed 3 fix-introduced issues — ALL fixed:
`console.assert` is a FAILED-assertion signal so it is now error-class (not benign); safeUrl now
strips userinfo FIRST and to the LAST `@` before the path, so a credential containing `@`/`?`/`#` is
fully removed. Round 3 (11 agents, the bounded cap) confirmed 3 MORE safeUrl edge-case leaks
(no-path `@`-in-query over-strip; leading-whitespace bypass; `/`-in-userinfo). Because a secret-leak
into evidence violates a non-negotiable hard rule (overriding the 3-round convention), safeUrl was
rewritten to use the WHATWG `URL` parser (host+path only; malformed authority => redacted) —
eliminating the hand-rolled-parser class by construction. Round 4 (focused verification) found that
`origin+pathname` still leaked userinfo for OPAQUE-path schemes (foo:user:pass@…, blob:…@…), where
the parser leaves userinfo inside pathname. Final invariant: render `protocol//host/path` ONLY when
host is non-empty (true authority — parser isolates userinfo); REDACT every opaque/rejected scheme
to its scheme. P0/P1/P2/P3 open: 0 / 0 / 0 / 0. A final round-5 verification runs on the fix commit.
