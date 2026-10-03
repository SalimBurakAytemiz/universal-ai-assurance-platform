# Policy Model (policy-as-code)

Machine-readable, versioned policy in `policies/*.json`, validated against
`schemas/policy.schema.json`. The schema requires `default: "DENY"` — fail-closed is a
structural property, not a convention.

- First matching rule wins; if none match, the request is denied (`default-deny`).
- An invalid document is treated as **deny-all** (`policy-invalid`), never silently allowed.
- The engine composes with the kernel as an AND-gate: it can only further restrict.
- Agents cannot modify policy (enforced in the agent schema: `canModifyPolicy: false`);
  policy change is a separate privileged operation.

Baseline policy (`policies/baseline.policy.json`) denies the prohibited class and production
active work, and allows passive + low-impact assurance in non-production. Tests:
`packages/policy-engine/test/policy.test.ts`.
