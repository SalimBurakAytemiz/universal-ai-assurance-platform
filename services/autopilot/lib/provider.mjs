// Provider availability gate. The autopilot NEVER fakes model execution and NEVER bypasses
// provider limits — it only observes whether a configured AI provider is currently usable, so
// AI-dependent work can be parked in WAITING_PROVIDER and resumed later instead of being lost.
import { existsSync, readFileSync } from "node:fs";

export class ProviderGate {
  /**
   * @param {{ probe?: () => boolean }} [opts] inject a probe for tests; default reads config/env.
   */
  constructor(opts = {}) {
    this._probe = opts.probe ?? defaultProbe;
  }

  /** @returns {boolean} whether an AI provider is currently available. */
  isAvailable() {
    try {
      return !!this._probe();
    } catch {
      return false; // fail-closed: unknown provider health => treat as unavailable, park the work
    }
  }
}

/**
 * Default probe: a provider is available if `.ai/autopilot/provider.json` says {"available":true}
 * or env UAAP_PROVIDER_AVAILABLE is "1"/"true". This is OBSERVATION only — it does not grant or
 * bypass anything. Absent config => unavailable (fail-closed).
 * @param {string} [controlPath]
 */
export function defaultProbe(controlPath = ".ai/autopilot/provider.json") {
  const env = process.env.UAAP_PROVIDER_AVAILABLE;
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  if (existsSync(controlPath)) {
    try {
      return readFileSync(controlPath, "utf8").includes('"available": true') || JSON.parse(readFileSync(controlPath, "utf8")).available === true;
    } catch {
      return false;
    }
  }
  return false;
}
