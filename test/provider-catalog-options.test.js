"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildCodexCatalog, parseCodexCatalog, parseCodexAutoReviewModel } = require("../src/lib/provider-switch/catalog");
const { projectCodex } = require("../src/lib/provider-switch/targets");

test("catalog keeps valid speed tiers, removes duplicates, and can disable unsupported tiers", () => {
  const official = [{ slug: "gpt-fixture", service_tiers: [null, { id: "invalid" },
    { id: "priority", name: "Fast", description: "Provider speed" },
    { id: "priority", name: "Duplicate", description: "duplicate" },
    { id: "ultrafast", name: "Ultra", description: "Extra speed" }],
    additional_speed_tiers: ["fast", "ultrafast", "fast", " ", false] }];
  const before = structuredClone(official);
  const rows = [{ model: "gpt-fixture" }];
  const model = JSON.parse(buildCodexCatalog(rows, official)).models[0];
  assert.deepEqual(model.service_tiers.map(tier => tier.id), ["priority", "ultrafast"]);
  assert.deepEqual(model.additional_speed_tiers, ["fast", "ultrafast"]);
  const disabled = JSON.parse(buildCodexCatalog(rows, official, { speedTiersEnabled: false })).models[0];
  assert.deepEqual(disabled.service_tiers, []);
  assert.deepEqual(disabled.additional_speed_tiers, []);
  assert.deepEqual(official, before);
});

test("auto review applies only a model in this provider catalog to every row and round trips", () => {
  const rows = [{ model: "main" }, { model: "reviewer" }];
  const content = buildCodexCatalog(rows, [], { autoReviewModel: " reviewer " });
  assert.deepEqual(JSON.parse(content).models.map(row => row.auto_review_model_override), ["reviewer", "reviewer"]);
  assert.equal(parseCodexAutoReviewModel(content), "reviewer");
  const invalid = buildCodexCatalog(rows, [], { autoReviewModel: "other-provider" });
  assert.equal(parseCodexAutoReviewModel(invalid), null);
  assert.equal(JSON.parse(invalid).models[0].auto_review_model_override, undefined);
  const mismatch = JSON.parse(content); mismatch.models[1].auto_review_model_override = "main";
  assert.equal(parseCodexAutoReviewModel(JSON.stringify(mismatch)), null);
  assert.equal(parseCodexCatalog(content, []).length, 2);
  const target = { meta: { codexCatalogModels: rows, codexAutoReviewModel: "reviewer", codexSpeedTiersEnabled: false }, settingsConfig: { config: {} } };
  assert.deepEqual(projectCodex({ target, liveToml: "" }).catalog.options, { autoReviewModel: "reviewer", speedTiersEnabled: false });
});
