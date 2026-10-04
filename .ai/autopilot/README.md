# Autopilot (session-independent)
Real runnable service in `services/autopilot/` (see docs/AUTOPILOT.md).
Durable state: `.ai/autopilot/jobs.json` (machine-local, gitignored).
Lifecycle: `node services/autopilot/cli.mjs start|stop|pause|resume|status|recover`.
