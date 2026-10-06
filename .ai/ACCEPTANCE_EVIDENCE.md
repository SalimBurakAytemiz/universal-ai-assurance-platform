# ACCEPTANCE EVIDENCE — Final Independent System Audit

> Executed evidence for the Final System Audit & Release-Candidate acceptance. Every row below was
> produced by an ACTUAL run on this host (not asserted). Reproduce with the exact commands shown.
> Frozen audit base: `git rev-parse HEAD` = **a80694299c0f292793e7efd46a16ff88e4e8dbe9** (branch
> `audit/final-acceptance-rc`, working tree clean apart from the added audit artifacts).

## Section 1/2 — DONE-node & traceability audit
- `npm run verify` → validators OK, typecheck OK, **491 tests / 39 files PASS** (was 477/38; +14 new E2E acceptance).
- Structural re-audit of all 62 DONE nodes: **0 false DONEs**. Every DONE node has real implementation
  (source + tests that execute), not doc-only/scaffold. Autopilot/github-automation nodes are backed by
  real `services/autopilot/lib/*.mjs` + 50 service tests + 25 merged PRs.

## Section 3 — 72-agent architecture (independently re-derived from `agents/registry/agents.json`)
Command: `node` over the raw registry (not just the validator). Result:
- totalAgents **72**, uniqueIds **72**, guilds **9**, per-guild **8 each** (9×8=72). ✓
- SoD permission violations: **0** — every agent has `canVerifyOwnFinding=false`, `canCloseOwnFinding=false`,
  `canSelfAuthorize=false`, `canExpandScope=false`, `canModifyPolicy=false`, `canExportSecret=false`
  (enforced by schema `const: false`, independently confirmed in the data). ✓
- Risk ceilings: R0_PASSIVE 25 / R1_LOW_IMPACT 43 / R2_ELEVATED 4; **R3_PROHIBITED 0** (schema forbids R3). ✓
- Skill references: **0 missing** (all agent skill refs resolve against the 143-skill registry). ✓
- Evidence requirement: **every detector (`canDetect=true`) has `evidenceRequired=true`**; the 38 agents
  without it are all `canDetect=false` (governance/coordination/evidence-handling/knowledge/automation/
  reporting) — correct, not a gap.
- Certification state (honest): **72 defined, 0 certified, all `DRAFT`**. Matches `canonicalAgents:
  {defined:72, implementedDefinitions:72, certified:0}`. Uncertified ≠ ACTIVE — correct by design.

## Section 8 — Desktop product (re-ran committed smokes; exit 0)
- `npm run smoke` → `{"ok":true,"ready":true,"windowCreated":true,"loaded":true,"text":"ready","title":"UAAP"}` (Electron 32.3.3).
- `npm run views` → `{"ok":true, checks:{homeDoneTotal,homeSecurity,agentsRealTotal,agentsCertified,
  securityLocked,knowledgeRendered,learningRendered all true}, agentsTotal:72, securityLocked:true,
  homeDone:62, homeTotal:64}`.
- No fake counters: the desktop renders REAL backend state — certified shows **0** (from MASTER_STATE,
  not fabricated), security posture **LOCKED_BY_DESIGN**, build graph **62/64** DONE.

## Section 9 — Full E2E acceptance (NEW, real execution): `tests/acceptance/e2e-acceptance.test.ts`
Synthetic project "ShopFlow" driven through the real composed pipeline. **14 tests PASS.**
- QUALITY/web (real `QualityWebEngine` via `driveEngine`): clean login flow → 0 findings (PASS);
  broken checkout flow → ≥4 distinct real defects (required-element-missing, forbidden-element-present,
  console-error, network-request-client-error), all localised to the broken flow (no false positives).
- SECURITY/appsec (real `SecurityAppsecEngine`): clean module clean; planted module detects
  hardcoded-secret + sql-injection-pattern — and the secret VALUE never appears in any finding/evidence
  (redaction by construction; asserted via full-output string search).
- Evidence chain of custody (`EvidenceStore`): real engine evidence recorded → bundled → `verifyBundle`
  TRUE; after an out-of-band record the SAME bundle verifies FALSE (tamper detected). CONFIDENTIAL
  evidence redacted in the redacted view while id+hash remain.
- Verification SoD (`VerificationEngine`): detector cannot verify own finding; CONFIRM refused without
  evidence; independent verifier CONFIRMS with evidence → status CONFIRMED.
- Remediation SoD (`RemediationEngine`): detector cannot remediate; PASS retest refused without evidence;
  remediator cannot validate own fix; remediator cannot close; independent closer closes → CLOSED with
  retest evidence bound in.
- Release Gate (`evaluateRelease`) — all four decisions proven fail-closed:
  RELEASE_BLOCKED (domain FAIL), RELEASE_BLOCKED (tampered evidence even when all PASS),
  RELEASE_BLOCKED (open P0 never acceptable even with a complete acceptance),
  HUMAN_APPROVAL_REQUIRED (NOT_RUN domain), RELEASE_ALLOWED_WITH_ACCEPTED_RISK (valid independent P1
  acceptance), RELEASE_ALLOWED (all PASS + evidence intact + nothing open). Self-approval (owner==approver) rejected.
- **Acceptance thesis proven**: the identical gate returns RELEASE_BLOCKED on the broken run and
  RELEASE_ALLOWED only after a real detect→verify→remediate→retest→close→clean-re-run arc. Green is EARNED.

## Section 10 — Autopilot / recovery (ran as part of verify)
- `services/autopilot/test/*` → autopilot 18 + ci-monitor 23 + instancelock 6 + monitor 3 = **50 tests PASS**
  (durable store, crash/restart state preservation, instance lock, WAITING_CI monitor, no duplicate
  commit/push/PR/merge). 24/7 is NOT claimed beyond this tested evidence.

## Section 12/13 — Evidence integrity & Release gate
- Covered by the Section 9 E2E above (tamper detection + all four gate outcomes, fail-closed).

## Section 14 — Supply chain
- Lockfiles present and in sync: root `package-lock.json` (166 pkgs, v3) + `apps/desktop/package-lock.json`.
- `npm audit --omit=dev` (production runtime): **0 vulnerabilities**. Root runtime deps: `ajv`, `ajv-formats`.
- No committed secrets: the repo's CI baseline grep
  (`AKIA[0-9A-Z]{16}` / private-key / `gh[pousr]_…`) over all tracked files (incl. the new test) → **clean**.
- KNOWN LIMITATION (dev/build toolchain only, never shipped): `npm audit` (incl. dev) reports advisories
  in the **Vitest test toolchain** (vitest, @vitest/mocker, vite, vite-node, esbuild, tinypool — 2 critical
  / 1 high / 3 moderate) and in the **Electron packaging toolchain** (`@electron/packager`→`@electron/get`
  — 3 high / 5 moderate). These are test/build-time dependencies; the shipped product does not import them.
  Not auto-fixed (upgrades are breaking and out of audit scope); recorded as a release note.

## Section 15 — Final adversarial repository review (3 bounded rounds over frozen HEAD)

An independent, fresh adversarial review was run as a multi-agent workflow (finders per vulnerability
class → each finding adversarially verified by a 3-skeptic majority-refute panel; auth/SoD/P0 claims
additionally re-verified by hand against the real code before any fix). It converged over 3 rounds
(the bounded cap): **round 1** (8 dimensions, 56 agents) confirmed 10, refuted 6; **round 2**
(verify-the-fixes, 29 agents) confirmed 5; **round 3** (converge, 22 agents) confirmed 5. Severity
declined each round as the critical issues were closed.

**20 distinct issues found — by severity: P0×1, P1×7, P2×7, P3×5.** 19 fixed with regression tests; 1
accepted + documented (below). Highlights:
- **P0 — authorization bypass (trust kernel):** a caller could self-assert `actionClass=R0_PASSIVE` to
  skip every authorization gate (no record / scope / env / ceiling / data-policy) for a target-touching
  action. FIXED: the kernel now binds the EFFECTIVE class to `max(declared, catalog)` from the
  action→class catalog (trusted), so passivity is decided by the catalog, never the caller. Regression:
  `tests/safety/boundary.test.ts` + `kernel.test.ts`.
- **P1 — environment scope confusion:** `request.environment` was never reconciled with
  `target.environment`. FIXED: kernel denies (AMBIGUOUS_SCOPE) on mismatch.
- **P1 — expiry via caller time:** authorization-window + lease-expiry used caller-supplied
  `request.now`. FIXED: kernel + broker evaluate expiry against an injected TRUSTED clock; the
  tamper-evident ledger's decision/lease timestamps are trusted-clock stamped too.
- **P1 — release-gate self-approval:** case-sensitive owner==approver guard. FIXED: shared
  `canonicalIdentity()` (NFKC + strip invisibles + trim + case-fold) applied across release-gate,
  verification, and remediation SoD checks.
- **P2 — lease scope not enforced:** broker stored `lease.scope` but never checked it. FIXED: broker
  enforces `request.target.identifiers ⊆ lease.scope`.
- **P2 — autopilot lock leak & atomic-write race:** lock released only after the loop (leaked on an
  earlier throw) and a dir-wide tmp sweep raced concurrent control-file writers. FIXED: lock release in
  `finally` covering recover/resume/loop; the tmp sweep was removed (unlink-own-tmp-on-any-failure
  retained), eliminating the cross-writer race.
- **P2 — desktop false-green:** `healthColor` substring match painted `NOT_IMPLEMENTED`/`UNHEALTHY`
  green, and the nav badged `NOT AVAILABLE` views as green "live". FIXED: tokenized allow-list + negation
  guard; `live` flag removed from the Release/Audit views.
- **P3×5:** `.test` TLD SSRF (dropped from the local allow-list — Chrome does not pin it), and
  audit/evidence timestamp hardening — all fixed.

**ACCEPTED + DOCUMENTED residual (1, P2-labeled, defense-in-depth):** `canonicalIdentity` uses
`String.toLowerCase()`, which approximates — does not fully implement — Unicode case folding, so a few
exotic code points (e.g. ß↔ss, locale-sensitive dotted/dotless I) remain un-folded. The SoD
owner≠approver / verifier≠detector check is an identity *sanity guard* over an ASCII component/attested
human identity space, not a cryptographic identity boundary (a determined insider controlling both
fields could use two genuinely different strings, which is out of scope for any string-equality guard).
NFKC + invisible-character stripping + case-insensitive compare closes the realistic cases; the narrow
residual is recorded here and in `.ai/KNOWN_ISSUES.md` rather than closed with a locale-sensitive
case-fold table that could introduce its own bugs. See `packages/core/src/ids.ts`.

**Final review posture (after 3 rounds):** OPEN P0 **0** / P1 **0** / P2 **1 (accepted, documented)** /
P3 **0**. `npm run verify` after all fixes: validators OK, typecheck OK, **500 tests / 39 files PASS**.
The security-active-validation gate remained LOCKED_BY_DESIGN throughout; no gate was weakened — every
fix STRENGTHENED a gate.

## Legitimate blockers KEPT (Section 17 — unchanged, correct)
- `security-active-validation-gate` → **LOCKED_BY_DESIGN** (needs a signed, scoped human authorization
  record in `.ai/security/`). Not closed.
- `desktop-update-rollback` → NOT_STARTED (needs code-signing cert + update host). Production code-signing
  → `DESKTOP_SIGNING_REQUIRED` (no cert; dev/unsigned build done + validated only).
- Final license → `FINAL_LICENSE_DECISION_REQUIRED` (business/legal; all-rights-reserved default stays).
- Live external research fetch → gated (offline pipeline built + tested).
