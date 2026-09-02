/**
 * Regression compare between two results files (issue #119 item 3).
 *
 * Fails when pass_rate drops by more than PASS_RATE_DROP_POINTS percentage
 * points or median structuredContent bytes per question rise by more than
 * BYTES_RISE_RATIO — a quality fix that costs tokens shows up here, which is
 * the whole point of measuring both.
 */

export const PASS_RATE_DROP_POINTS = 10;
export const BYTES_RISE_RATIO = 0.25;

/**
 * @param {{service?: string, mode?: string, metrics: object}} previous
 * @param {{service?: string, mode?: string, metrics: object}} current
 * @returns {{ok: boolean, reasons: string[], warnings: string[], deltas: object}}
 */
export function compareResults(previous, current, { dropPoints = PASS_RATE_DROP_POINTS, riseRatio = BYTES_RISE_RATIO } = {}) {
  const reasons = [];
  const warnings = [];
  const p = previous?.metrics ?? {};
  const c = current?.metrics ?? {};
  if (previous?.service && current?.service && previous.service !== current.service) {
    warnings.push(`comparing ${previous.service} with ${current.service}`);
  }
  if (previous?.mode && current?.mode && previous.mode !== current.mode) {
    warnings.push(`previous run is ${previous.mode}, current is ${current.mode} — bytes are comparable, pass rates are not`);
  }
  const deltas = {};
  if (typeof p.pass_rate === 'number' && typeof c.pass_rate === 'number') {
    deltas.pass_rate_points = Math.round((c.pass_rate - p.pass_rate) * 10) / 10;
    if (p.pass_rate - c.pass_rate > dropPoints) {
      reasons.push(`pass_rate dropped ${p.pass_rate} -> ${c.pass_rate} (> ${dropPoints} points)`);
    }
  }
  if (typeof p.median_structured_bytes === 'number' && typeof c.median_structured_bytes === 'number' && p.median_structured_bytes > 0) {
    const ratio = c.median_structured_bytes / p.median_structured_bytes - 1;
    deltas.median_structured_bytes_ratio = Math.round(ratio * 1000) / 1000;
    if (ratio > riseRatio) {
      reasons.push(`median structuredContent bytes rose ${p.median_structured_bytes} -> ${c.median_structured_bytes} (+${Math.round(ratio * 100)}%, > ${Math.round(riseRatio * 100)}%)`);
    }
  }
  return { ok: reasons.length === 0, reasons, warnings, deltas };
}
