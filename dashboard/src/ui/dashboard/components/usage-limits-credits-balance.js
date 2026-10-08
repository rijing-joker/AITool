import { copy, getCopyLocale } from "../../../lib/copy";

// Codex Credits are metered at API prices: the official rate card's credits
// per 1M tokens equal the API dollar price × 25, i.e. one credit is $0.04.
// The API does not expose the ratio (cc-switch's CODEX_USD_PER_CREDIT) —
// when OpenAI reprices, this constant is the only thing to touch.
export const CODEX_USD_PER_CREDIT = 0.04;

export function buildCreditsBalanceLine(balance) {
  // The src-side wham normalizer already guarantees a positive finite number;
  // this helper renders, it does not parse.
  if (typeof balance !== "number" || !Number.isFinite(balance) || balance <= 0) return null;
  // Whole dollars, no thousands separator ("≈ $2500"); below $1 renders "<$1".
  const usdTotal = balance * CODEX_USD_PER_CREDIT;
  const usd = usdTotal >= 1 ? `$${Math.round(usdTotal)}` : "<$1";
  let count;
  try {
    count = new Intl.NumberFormat(getCopyLocale(), { maximumFractionDigits: 2 }).format(balance);
  } catch {
    count = String(balance);
  }
  return {
    key: "codex_credits_balance",
    count,
    usd,
    text: copy("limits.codex_credits_balance.line", { count, usd }),
  };
}
