// Shared USD cost formatting for estimated per-request / per-session costs
// (models.dev pricing). A plain module (not JSX) keeping number formatting
// utilities beside the other format helpers.

export function formatCostUsd(costUsd) {
  if (!Number.isFinite(costUsd)) return null;
  if (costUsd > 0 && costUsd < 0.0001) return "<$0.0001";
  const amount = costUsd >= 100 ? costUsd.toFixed(0) : costUsd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `$${amount}`;
}
