// Canonical autopilot runtime states (shared by the service, store, and CLI).
// Plain Node ESM so the service runs with zero build step, independently of any Claude session.

export const RuntimeState = Object.freeze({
  READY: "READY",
  RUNNING: "RUNNING",
  WAITING_PROVIDER: "WAITING_PROVIDER",
  WAITING_CI: "WAITING_CI",
  WAITING_APPROVAL: "WAITING_APPROVAL",
  BLOCKED: "BLOCKED",
  RETRY_SCHEDULED: "RETRY_SCHEDULED",
  VALIDATING: "VALIDATING",
  REVIEWING: "REVIEWING",
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
