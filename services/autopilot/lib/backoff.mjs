// Bounded exponential backoff for AI task retries. Pure and deterministic.

/**
 * @param {number} attempt zero-based attempt count already made
 * @param {{baseMs?:number,maxMs?:number,factor?:number}} [opts]
 * @returns {number} delay in ms before the next attempt
 */
export function computeBackoffMs(attempt, opts = {}) {
  const base = opts.baseMs ?? 1000;
  const factor = opts.factor ?? 2;
  const max = opts.maxMs ?? 15 * 60 * 1000; // 15 min cap
  const n = Math.max(0, Math.floor(attempt));
  const delay = base * Math.pow(factor, n);
  return Math.min(delay, max);
}

/** ISO timestamp `now` + backoff(attempt). */
export function nextRetryAt(nowIso, attempt, opts = {}) {
  const t = Date.parse(nowIso);
  const ms = computeBackoffMs(attempt, opts);
  return new Date(t + ms).toISOString();
}
