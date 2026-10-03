# SESSION PROTOCOL

Every new session / recovery:
1. `git status`; `git branch --show-current`; `git log --oneline -10`; `gh auth status`
2. Read `.ai/MASTER_STATE.json`, `.ai/BUILD_GRAPH.json`, `.ai/NEXT_ACTIONS.md`, `CLAUDE.md`
3. `npm install` (if needed); `npm run verify`
4. Reconcile — do NOT restart or overwrite valid work; do NOT recreate the repository.
5. Pick the next READY build-graph node and continue; no permission needed for normal dev.
6. At each validated checkpoint: update `.ai/*`, commit, push, PR, CI, review, safe-merge, sync.

Conversation history is NOT project state. Repo + Git + tests + CI are the source of truth.
