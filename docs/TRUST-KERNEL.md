# Trust Kernel (fail-closed)

`@uaap/authorization-kernel`. Evaluates one `ActionRequest` and returns `ALLOW`, `DENY`, or
`HUMAN_APPROVAL_REQUIRED`. **There is no code path that returns ALLOW by default.**

Ordered gates (any failure short-circuits to DENY / approval):

0. **Structure** — malformed request / unknown mode -> DENY.
1. **Action known and not prohibited** — unknown action -> DENY `UNKNOWN_ACTION`; R3 class -> DENY `PROHIBITED_ACTION_CLASS`.
2. **Target unambiguous** — no id / no identifiers -> DENY `AMBIGUOUS_TARGET`.
3. **Mode / authorization** — `PROSPECT_PASSIVE` may only do passive (R0). Any active (R1+)
   action requires a matching `AuthorizationRecord`; none -> DENY `AUTHORIZATION_MISSING`.
4. **Time window** — request time outside `[notBefore, notAfter)` -> DENY `AUTHORIZATION_EXPIRED`.
5. **Scope** — every target identifier and the domain must be in the authorization, else `OUT_OF_SCOPE`.
6. **Environment** — must be in the authorized environments, else `ENVIRONMENT_FORBIDDEN`.
7. **Action ceiling** — class above authorized ceiling -> `OUT_OF_SCOPE`; R2 without approval token -> `HUMAN_APPROVAL_REQUIRED`.
8. **Data policy** — full access to RESTRICTED data off an owned target -> `DATA_POLICY_VIOLATION`.
9. **Policy-as-code** — the Policy Engine must also permit the request.

Passive (R0) known actions are permitted without an authorization record (public/metadata only),
but still pass the known-action, prohibited-class, and policy gates. Proven by
`packages/authorization-kernel/test/kernel.test.ts` (17 cases) and `tests/safety/boundary.test.ts`.
