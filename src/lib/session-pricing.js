const { estimateCostUsd } = require("./proxy/pricing");

function priceSessionUsage(usage, models) {
  const entries = usage?.perModel;
  if (!Array.isArray(entries) || !entries.length) return;
  let total = 0;
  let priced = 0;
  for (const entry of entries) {
    const cost = estimateCostUsd(models, entry.model, entry, {
      inputInclusive: usage.inputInclusive,
      executorType: usage.executorType,
    });
    if (cost != null) {
      total += cost;
      priced++;
    }
  }
  usage.pricedModels = priced;
  usage.totalModels = entries.length;
  if (priced) usage.estimatedCostUsd = total;
  else delete usage.estimatedCostUsd;
}

module.exports = { priceSessionUsage };
