"use strict";

const FIELD = "cache_creation_1h_input_tokens";
function cacheCreation1h(value) {
  const total = Math.max(0, Number(value?.cache_creation_input_tokens ?? value?.cacheCreationTokens) || 0);
  const raw = value?.[FIELD] ?? value?.cacheCreation1hTokens ?? value?.cache_creation?.ephemeral_1h_input_tokens;
  const count = Number(raw);
  return Number.isFinite(total) && Number.isFinite(count) ? Math.floor(Math.min(total, Math.max(0, count))) : 0;
}
function cacheSubset(value) {
  const count = cacheCreation1h(value);
  return count > 0 ? { [FIELD]: count } : {};
}
function addCacheSubset(target, value) {
  const count = cacheCreation1h(value);
  if (count > 0) target[FIELD] = (Number(target[FIELD]) || 0) + count;
}
module.exports = { cacheCreation1h, cacheSubset, addCacheSubset };
