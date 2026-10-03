# Desktop UX

The desktop app (`apps/desktop`, Electron) is the primary human control plane. The user does
not need to watch a terminal for daily use.

Principle: **no fake dashboards.** A section whose backend is not implemented shows
`NOT AVAILABLE` / `NOT CONFIGURED` / `BLOCKED` — never a fake green status. Today, Home,
System Health, Agents (counts), Authorization, Release Center, Audit, and Build Graph read
real `.ai` state; all other sections are explicitly marked not available.

Run it: `npm run desktop:dev` (installs Electron into `apps/desktop` on first run).
Packaging/update/rollback is NOT configured yet (build-graph node `desktop-packaging`).
