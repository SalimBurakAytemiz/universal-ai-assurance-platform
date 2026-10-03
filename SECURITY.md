# Security Policy

The Universal AI Assurance Platform is a **defensive** software-assurance tool. Its
security model is enforced in code, not in prose, and defaults to denial.

## Core safety invariants (enforced by the Trust Kernel)

1. **Fail closed.** The default decision for any action is `DENY`. There is no
   implicit `ALLOW`.
2. **No authorization → no active validation.** Active, target-touching security
   validation is unavailable until an authorization record with an explicit scope
   exists in persistent state.
3. **Ambiguous → DENY.** Ambiguous target, ambiguous scope, or unknown action class
   resolve to `DENY` (or `HUMAN_APPROVAL_REQUIRED`), never to `ALLOW`.
4. **No direct agent → target path.** Every target-touching action is routed
   `Agent → Orchestrator → Authorization Kernel → Policy Engine → Tool Broker → Target`.
   A direct agent-to-target call is an architecture violation and is covered by tests.
5. **Prohibited baseline.** Destructive state change, denial-of-service / resource
   exhaustion, persistence, credential theft, and data exfiltration are denied by
   default and are not unlocked by configuration in this repository.
6. **Separation of duties.** The component that detects a finding cannot close it.
7. **No secrets in the repo.** Packages receive secret *references*; the Tool Broker
   injects real values at runtime. Environment variable names only.

## This is not offensive tooling

This project exists for QA and authorized, defensive security validation against
systems the operator owns or is explicitly authorized to test. It must not be used,
and is not designed, to compromise third-party systems. Provider safety mechanisms
are never bypassed.

## Reporting

This is a private, owner-operated repository. Report security concerns directly to
the repository owner.
