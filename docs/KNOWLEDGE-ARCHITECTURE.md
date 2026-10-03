# Knowledge and Continuous Learning

**SELF-LEARNING is not SELF-TRUSTING. NEW is not BETTER. A CVE match is not a confirmed
vulnerability.**

Knowledge layers: L0 governance · L1 core engineering · L2 tool/framework (version-aware) ·
L3 domain · L4 project (isolated) · L5 runtime (ephemeral) · L6 external candidates.

Trust order: authorization/policy -> actual project facts -> verified org knowledge ->
certified knowledge -> domain knowledge -> external research -> model general knowledge.
Model pretraining never overrides a repository fact.

Every knowledge item carries provenance and a lifecycle (schema:
`schemas/knowledge-item.schema.json`): `DISCOVERED -> CANDIDATE -> SOURCE_VERIFIED ->
SANDBOXED -> EVALUATED -> REVIEWED -> CERTIFIED -> ACTIVE`, with
`STALE/DEPRECATED/REVOKED/SUPERSEDED`. External information can never be `ACTIVE` directly.
Scope is one of {GLOBAL, ORGANIZATION, PROJECT, RUN}; project-private knowledge must not leak
to global knowledge.

Status: the schema + validator exist (`scripts/validate-knowledge.mjs`). The store, lifecycle
engine, decay detection, research pipeline, and sandbox/evaluation are NOT_STARTED (tracked in
the build graph).
