import { useCallback } from "react";
import { useCurrency } from "./useCurrency";
import { formatCost } from "../lib/cost-format";

export function useCostFormatter() {
  const { rate, symbol } = useCurrency();
  return useCallback((usd, exact = false) => formatCost(usd, { rate, symbol }, exact), [rate, symbol]);
}
