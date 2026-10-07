// Aggregate per-model speed formatting for the Overview "By model" stats
// (cc-switch c615c3e port). The backend sums eligible rows only — exact speed
// from rows with first-token timing (Σoutput ÷ Σgeneration ms), estimated
// speed from rows without TTFT (Σoutput ÷ Σtotal ms). A row is exact OR
// estimated, so at most one numerator/denominator pair is non-zero.

export function getAggregateTokensPerSecond(outputTokens, durationMs) {
  const output = Number(outputTokens);
  const duration = Number(durationMs);
  if (!Number.isFinite(output) || !Number.isFinite(duration) || output <= 0 || duration <= 0) return null;
  const speed = (output / duration) * 1000;
  return Number.isFinite(speed) && speed > 0 ? speed : null;
}

// Returns "123.4 t/s" (exact) or "≈ 67.8 t/s" (estimated fallback), or null
// when the model has no speedable requests.
export function formatAggregateSpeed(stat) {
  const exact = getAggregateTokensPerSecond(stat?.speed_output_tokens, stat?.speed_generation_ms);
  if (exact != null) return `${exact.toFixed(1)} t/s`;
  const estimated = getAggregateTokensPerSecond(stat?.est_speed_output_tokens, stat?.est_speed_duration_ms);
  if (estimated != null) return `≈ ${estimated.toFixed(1)} t/s`;
  return null;
}
