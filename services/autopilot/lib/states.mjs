// Canonical autopilot runtime states (shared by the service, store, and CLI).
// Plain Node ESM so the service runs with zero build step, independently of any Claude session.

// Active states are set by the scheduler today: READY, RUNNING, WAITING_PROVIDER, WAITING_APPROVAL
// (recovery/reconciliation of side-effecting jobs), BLOCKED, RETRY_SCHEDULED, DONE, FAILED.
// Reserved for the review/release pipeline integration (declared for forward-compat, not yet
// emitted by the scheduler): WAITING_CI, VALIDATING, REVIEWING.
export const RuntimeState = Object.freeze({
  READY: "READY",
  RUNNING: "RUNNING",
  WAITING_PROVIDER: "WAITING_PROVIDER",
  WAITING_CI: "WAITING_CI", // reserved
  WAITING_APPROVAL: "WAITING_APPROVAL",
  BLOCKED: "BLOCKED",
  RETRY_SCHEDULED: "RETRY_SCHEDULED",
  VALIDATING: "VALIDATING", // reserved
  REVIEWING: "REVIEWING", // reserved
  DONE: "DONE",
  FAILED: "FAILED",
});

/** Terminal states — never re-run. Recovery relies on these to avoid duplicate side effects. */
export const TERMINAL = Object.freeze(new Set([RuntimeState.DONE, RuntimeState.FAILED]));

/** States that are "waiting" on an external condition (not actively runnable this tick). */
export const WAITING = Object.freeze(
  new Set([RuntimeState.WAITING_PROVIDER, RuntimeState.WAITING_CI, RuntimeState.WAITING_APPROVAL]),
);

export function isValidState(s) {
  return Object.values(RuntimeState).includes(s);
}
