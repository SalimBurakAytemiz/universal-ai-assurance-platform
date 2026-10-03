# CLAUDE.md — operational contract (read this first, every session)

This file is the short operational summary. The full requirements live in
`docs/` and `docs/REQUIREMENT-TRACEABILITY.md`. The authoritative live state lives
in `.ai/`. **The repository + Git + tests + CI are the source of truth — not chat.**

## What this is

One product, one repository, one desktop application. A local-first AI software
**assurance** platform. Quality and Security are domains over one shared core.
It is a defensive QA/security tool — never offensive tooling, never a provider-safety
bypass.

## Session start / recovery procedure

1. `git status`, `git branch --show-current`, `git log --oneline -5`
2. Read `.ai/MASTER_STATE.json`, `.ai/BUILD_GRAPH.json`, `.ai/NEXT_ACTIONS.md`
3. `npm install` if needed, then `npm run verify`
4. Pick the next `READY` node in the build graph and continue. Do not ask the user
   for permission to do normal development (edit, test, lint, build, branch, commit,
   push, open/update PR, review, safe-merge, sync main, continue).

## Hard rules (enforced in code where possible, honored always)

- **Fail closed.** Default decision = `DENY`. No implicit `ALLOW`.
- **No authorization → no active validation.** Active security validation stays locked
  until an authorization record + explicit scope exist in `.ai/security/`.
- **Ambiguous / out-of-scope / unknown action → DENY.**
- **No direct `Agent → Target`.** Always `Agent → Orchestrator → Kernel → Policy →
  Tool Broker → Target`. There is a test that fails if this is bypassed.
- **Prohibited baseline** (deny by default, not unlockable here): destructive change,
  DoS/resource exhaustion, persistence, credential theft, data exfiltration.
- **Separation of duties:** detector ≠ verifier ≠ remediator ≠ closure authority.
- **No secrets in repo / prompts / logs / evidence.** Secret *references* only.
- **No fake anything.** Documented = DOCUMENTED. Interface-only = SCAFFOLDED.
  Untested = UNVALIDATED. Blocked = BLOCKED. Never say COMPLETE without real execution.
- **Git safety:** no force push, no history rewrite, no protected-branch delete, no CI
  bypass. Logical bounded commits.

## Status vocabulary

`NOT_STARTED` · `READY` · `RUNNING` · `BLOCKED` · `VALIDATING` · `REVIEWING` · `DONE`
and for capabilities: `DOCUMENTED` · `SCAFFOLDED` · `UNVALIDATED` · `BLOCKED` ·
`IMPLEMENTED` (real code) · `IMPLEMENTED+TESTED`.

## HUMAN_ACTION_REQUIRED (the only real stop reasons)

Missing external credentials; external target authorization; scope expansion;
production elevated-risk testing; legal/business decisions (e.g. final license);
paid-service purchase; irreversible external action. A single blocker must not stop
independent work — continue other `READY` nodes.

## Verify command

```bash
npm run verify   # validate (policies + build graph + state) → typecheck → test
```
