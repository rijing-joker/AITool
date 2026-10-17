// Shared USD cost formatting for estimated per-request / per-session costs
// (models.dev pricing). A plain module (not JSX) keeping number formatting
// utilities beside the other format helpers.

export function formatCostUsd(costUsd) {
  return formatCost(costUsd);
}

export function formatCost(costUsd, { rate = 1, symbol = "$" } = {}, exact = false) {
  if (!Number.isFinite(costUsd)) return null;
  const value = costUsd * (Number.isFinite(rate) && rate > 0 ? rate : 1);
  if (exact) return `${symbol}${value.toFixed(6)}`;
  if (value > 0 && value < 0.0001) return `<${symbol}0.0001`;
  const amount = value >= 100 ? value.toFixed(0) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `${symbol}${amount}`;
}
