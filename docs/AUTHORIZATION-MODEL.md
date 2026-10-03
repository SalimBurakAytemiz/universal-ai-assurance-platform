# Authorization Model

Active security validation is **locked by design** until a signed, scoped authorization
record exists. Chat messages never confer authorization or ownership; state does.

## AuthorizationRecord (see `@uaap/core`)
`id, mode, targetId, allowedIdentifiers[], maxActionClass, allowedEnvironments[],
allowedDomains[], notBefore, notAfter, grantedBy, reference`.

Records live in `.ai/security/AUTHORIZATION_STATE.json`. It is empty by design; adding a
record is a deliberate human action. `scripts/validate-state.mjs` fails if there are zero
authorizations yet active validation is not `LOCKED_BY_DESIGN`.

## Modes
- `PROSPECT_PASSIVE` — public/passive only; no active testing, ever.
- `CLIENT_AUTHORIZED` — explicit authorization + explicit scope.
- `INTERNAL_OWNED` — ownership declared in state.

## Action risk classes
`R0_PASSIVE` · `R1_LOW_IMPACT` · `R2_ELEVATED` (per-action human approval) · `R3_PROHIBITED`
(destructive / DoS / persistence / credential-theft / exfiltration — denied by default, not
unlockable in this repository).
