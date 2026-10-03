# SAFETY GATE

Active security validation is LOCKED until ALL hold:
- authorization-kernel: CLEAN  (implemented + tested)
- policy-engine: CLEAN  (implemented + tested)
- audit/provenance: CLEAN  (implemented + tested)
- agent-permission-graph: not yet built
- an explicit, signed, scoped authorization record exists in security/AUTHORIZATION_STATE.json

Current gate: **LOCKED_BY_DESIGN** (no authorization record exists).
