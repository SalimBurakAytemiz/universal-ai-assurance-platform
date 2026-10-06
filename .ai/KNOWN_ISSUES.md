# KNOWN ISSUES / OPEN ITEMS

| id | item | status |
|----|------|--------|
| REQ-GOV-LICENSE | Final product license undecided (HUMAN_ACTION_REQUIRED). Default: all rights reserved. | OPEN |
| HAR-SEC-AUTH | Active security validation locked: no external authorization/scope exists. | LOCKED_BY_DESIGN |
| DESKTOP-RUN | Electron PROVEN on this host: project-local install + headless BrowserWindow smoke passed (electron v32.3.3, exit 0). Desktop shell/views/dev-packaging are technically executable here. See `.ai/ENVIRONMENT_PROOF.md`. | RESOLVED |
| ENGINES | Quality/Security/Data/Perf/Reliability/Privacy engines are NOT_STARTED (interfaces/contracts only). | OPEN |
| DOCKER | Docker not installed on build host. Sandbox-learning now uses a safe local Node-child sandbox alternative (bounded, audited, fail-closed); OS-level adversarial-code isolation still needs a container/VM runtime (addable behind the same interface). See `.ai/ENVIRONMENT_PROOF.md`. | ALTERNATIVE_IN_USE |
| PROJECT-STORE-CONCURRENCY | ProjectStore is single-process local-first; no cross-process write locking (atomic temp+rename prevents torn files, but concurrent multi-process writers can lose updates). | ACCEPTED_FOR_NOW |
| DESKTOP-SIGNING | Production desktop code-signing + signed auto-update channel need a code-signing certificate (not present; cannot be safely synthesized). Dev/unsigned Windows package is built + startup-validated (see `.ai/PACKAGING_EVIDENCE.json`). | DESKTOP_SIGNING_REQUIRED |
