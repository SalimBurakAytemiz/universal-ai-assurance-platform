# GitHub Automation

Normal validated work follows: implement -> format/lint -> typecheck -> test -> update `.ai`
-> commit -> push -> PR -> CI -> isolated review -> fix -> re-review -> safe-merge ->
sync main -> next.

Safe-merge requires: required local tests PASS, required CI PASS, policy/safety tests PASS,
reviewed HEAD == merge HEAD, unresolved P0/P1 == 0, no security-boundary regression, `.ai`
current. **Never** force-push, rewrite history, delete protected branches, or bypass CI.

Current state (`.ai/GITHUB_STATE.json`): the repository is created private and the initial
canonical state is pushed to `main` this session. Subsequent build-graph nodes proceed on
work-item branches with PRs. If GitHub auth is ever unavailable, local validated work is
preserved and `GITHUB_AUTH_REQUIRED` is recorded; independent local work continues.
