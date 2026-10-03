# DECISIONS (append-only decision log)

- **2026-10-03** Canonical product = ONE product / ONE repository / ONE desktop. QA and
  Security are domains over one shared core, not separate repositories. (Master contract §0.)
- **2026-10-03** Execution model = dependency-aware continuous build graph, not phases.
- **2026-10-03** Stack = TypeScript monorepo (npm workspaces) + Vitest + Ajv; Electron for
  the desktop shell (Windows-first, cross-platform kept possible). Rationale: Node 24/npm 11
  already present; no Rust toolchain (Tauri needs cargo, not installed).
- **2026-10-03** The Trust Kernel is the single fail-closed authority (default DENY). The
  Policy Engine composes as an AND-gate that can only further restrict.
- **2026-10-03** Adapters are private to the Tool Broker; the Orchestrator exposes no adapter,
  broker, or kernel to agents — the no-direct-agent-to-target rule is structural, with a test.
- **2026-10-03** Repository = PRIVATE. Final license is a pending business/legal decision;
  conservative "all rights reserved" default committed meanwhile.
- **2026-10-03** 72 canonical agents are ROLE DEFINITIONS (9 guilds x 8), not 72 live LLMs.
  Agent != Model != Skill != Tool != Domain.
