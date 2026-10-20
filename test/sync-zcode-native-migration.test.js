const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const {
  repairZcodeInclusiveTokenMigration,
  repairZcodeNativeUsageMigration,
  repairZcodePruneWindowRestore,
  resolveZcodeRebuildFloorMs,
  ZCODE_PRUNE_WINDOW_RESTORE_KEY,
} = require("../src/commands/sync");

function row(source, model, hour, total) {
  return JSON.stringify({
    hour_start: hour,
    source,
    model,
    input_tokens: total,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
    conversation_count: 1,
  });
}

test("native ZCode migration purges legacy rows once and preserves unrelated usage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-native-repair-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const projectQueueStatePath = path.join(tmp, "project.queue.state.json");
    const hour = "2026-06-15T09:00:00Z";
    await fs.writeFile(queuePath, [row("zcode", "GLM-5.2", hour, 12), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(projectQueuePath, [row("zcode", "GLM-5.2", hour, 12), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 100 }));
    await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 50 }));
    const cursors = {
      zcode: { messages: { "legacy|row": { lastTotals: { total_tokens: 12 }, attribution: `${hour}\tGLM-5.2\t\t` } } },
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${hour}`]: { totals: { total_tokens: 12 } },
          [`codex|gpt-5|${hour}`]: { totals: { total_tokens: 20 } },
        },
        groupQueued: { [`zcode|${hour}`]: "legacy", [`codex|${hour}`]: "keep" },
      },
      projectHourly: {
        buckets: {
          [`project|zcode|${hour}`]: { totals: { total_tokens: 12 } },
          [`project|codex|${hour}`]: { totals: { total_tokens: 20 } },
        },
      },
      migrations: {},
    };

    const changed = await repairZcodeNativeUsageMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
      rebuildFloorMs: Date.parse(hour),
    });
    assert.equal(changed, true);
    const mainRows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const zcodeRetractions = mainRows.filter((entry) => entry.source === "zcode");
    assert.equal(zcodeRetractions.at(-1).total_tokens, 0, "latest snapshot retracts the key");
    assert.equal(zcodeRetractions[0].total_tokens, 12, "original queue prefix remains intact");
    assert.equal((await fs.readFile(projectQueuePath, "utf8")).trim().split("\n").map(JSON.parse).filter((entry) => entry.source === "zcode").at(-1).total_tokens, 0);
    assert.ok(cursors.hourly.buckets[`codex|gpt-5|${hour}`]);
    assert.ok(!Object.keys(cursors.hourly.buckets).some((key) => key.startsWith("zcode|")));
    assert.ok(!Object.keys(cursors.projectHourly.buckets).some((key) => key.includes("|zcode|")));
    assert.equal(cursors.zcode, undefined);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
    assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).offset, 0);

    const changedAgain = await repairZcodeNativeUsageMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
      rebuildFloorMs: Date.parse(hour),
    });
    assert.equal(changedAgain, false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("inclusive-token ZCode migration retracts prior totals and resets replay once", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-inclusive-repair-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const projectQueueStatePath = path.join(tmp, "project.queue.state.json");
    const hour = "2026-08-31T09:00:00Z";
    await fs.writeFile(queuePath, [row("zcode", "GLM-5.2", hour, 100), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(projectQueuePath, [row("zcode", "GLM-5.2", hour, 100), row("codex", "gpt-5", hour, 20)].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 100 }));
    await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 50 }));
    const cursors = {
      zcode: { messages: { "legacy|row": { lastTotals: { total_tokens: 100 }, attribution: `${hour}\tGLM-5.2\t\t` } } },
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${hour}`]: { totals: { total_tokens: 100 } },
          [`codex|gpt-5|${hour}`]: { totals: { total_tokens: 20 } },
        },
        groupQueued: { [`zcode|${hour}`]: "inflated", [`codex|${hour}`]: "keep" },
      },
      projectHourly: {
        buckets: {
          [`project|zcode|${hour}`]: { totals: { total_tokens: 100 } },
          [`project|codex|${hour}`]: { totals: { total_tokens: 20 } },
        },
      },
      migrations: {},
    };

    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
      rebuildFloorMs: Date.parse(hour),
    }), true);
    const replayRows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(replayRows.filter((entry) => entry.source === "zcode").at(-1).total_tokens, 0);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).note,
      "reset_after_zcode_inclusive_token_repair_2026_09");
    assert.equal(JSON.parse(await fs.readFile(projectQueueStatePath, "utf8")).note,
      "reset_after_zcode_inclusive_token_repair_2026_09");
    assert.equal(cursors.zcode, undefined);

    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
      rebuildFloorMs: Date.parse(hour),
    }), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode wipe preserves pre-window queue rows and buckets (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-preserve-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const projectQueuePath = path.join(tmp, "project.queue.jsonl");
    const projectQueueStatePath = path.join(tmp, "project.queue.state.json");
    const oldHour = "2026-09-01T09:00:00.000Z";
    const liveHour = "2026-10-10T09:00:00.000Z";
    const floorMs = Date.parse("2026-09-17T00:00:00.000Z");
    await fs.writeFile(queuePath, [
      row("zcode", "GLM-5.2", oldHour, 5000),
      row("zcode", "GLM-5.2", liveHour, 100),
      row("codex", "gpt-5", liveHour, 20),
    ].join("\n") + "\n");
    await fs.writeFile(projectQueuePath, [
      row("zcode", "GLM-5.2", oldHour, 5000),
      row("zcode", "GLM-5.2", liveHour, 100),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 100 }));
    await fs.writeFile(projectQueueStatePath, JSON.stringify({ offset: 50 }));
    const cursors = {
      zcode: { messages: { "x": { lastTotals: { total_tokens: 100 } } } },
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${oldHour}`]: { totals: { total_tokens: 5000 } },
          [`zcode|GLM-5.2|${liveHour}`]: { totals: { total_tokens: 100 } },
          [`codex|gpt-5|${liveHour}`]: { totals: { total_tokens: 20 } },
        },
        groupQueued: {
          [`zcode|${oldHour}`]: "keep",
          [`zcode|${liveHour}`]: "wipe",
        },
      },
      projectHourly: {
        buckets: {
          [`proj|zcode|${oldHour}`]: { totals: { total_tokens: 5000 } },
          [`proj|zcode|${liveHour}`]: { totals: { total_tokens: 100 } },
        },
      },
      migrations: {},
    };

    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      projectQueuePath,
      projectQueueStatePath,
      rebuildFloorMs: floorMs,
    }), true);

    const mainRows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const zcodeRows = mainRows.filter((entry) => entry.source === "zcode");
    assert.equal(zcodeRows.some((entry) => entry.hour_start === oldHour && entry.total_tokens === 5000), true);
    assert.equal(zcodeRows.some((entry) => entry.hour_start === liveHour && entry.total_tokens === 0), true);
    assert.ok(cursors.hourly.buckets[`zcode|GLM-5.2|${oldHour}`]);
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${liveHour}`], undefined);
    assert.ok(cursors.hourly.groupQueued[`zcode|${oldHour}`]);
    assert.equal(cursors.hourly.groupQueued[`zcode|${liveHour}`], undefined);
    assert.ok(cursors.projectHourly.buckets[`proj|zcode|${oldHour}`]);
    assert.equal(cursors.projectHourly.buckets[`proj|zcode|${liveHour}`], undefined);
    assert.equal(cursors.migrations.zcodeInclusiveTokenRepair_2026_09.preservedMain, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode wipe skips when rebuild floor is unavailable but history exists (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-skip-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const hour = "2026-09-01T09:00:00.000Z";
    await fs.writeFile(queuePath, row("zcode", "GLM-5.2", hour, 5000) + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 10 }));
    const cursors = {
      hourly: {
        buckets: { [`zcode|GLM-5.2|${hour}`]: { totals: { total_tokens: 5000 } } },
        groupQueued: {},
      },
      migrations: {},
    };
    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: null,
    }), false);
    assert.equal(cursors.migrations.zcodeInclusiveTokenRepair_2026_09.skipped, true);
    assert.equal(JSON.parse((await fs.readFile(queuePath, "utf8")).trim()).total_tokens, 5000);
    assert.ok(cursors.hourly.buckets[`zcode|GLM-5.2|${hour}`]);

    // Retry succeeds once a floor is known.
    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), true);
    assert.ok(cursors.migrations.zcodeInclusiveTokenRepair_2026_09.appliedAt);
    assert.ok(cursors.hourly.buckets[`zcode|GLM-5.2|${hour}`]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode prune-window restore lifts pre-window peaks from queue backups (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-restore-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const oldHour = "2026-09-01T09:00:00.000Z";
    const liveHour = "2026-10-10T09:00:00.000Z";
    const backupPath = `${queuePath}.bak.2026-10-17T00-00-00-000Z`;
    await fs.writeFile(backupPath, [
      row("zcode", "GLM-5.2", oldHour, 9000),
      row("zcode", "GLM-5.2", liveHour, 50),
    ].join("\n") + "\n");
    await fs.writeFile(queuePath, [
      row("zcode", "GLM-5.2", oldHour, 0),
      row("zcode", "GLM-5.2", liveHour, 80),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 999 }));
    const cursors = {
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${oldHour}`]: { totals: { total_tokens: 0 } },
          [`zcode|GLM-5.2|${liveHour}`]: { totals: { total_tokens: 80 } },
        },
        groupQueued: {},
      },
      migrations: {},
    };

    assert.equal(await repairZcodePruneWindowRestore({
      cursors,
      queuePath,
      queueStatePath,
      dbPaths: [],
    }), false, "no floor and no db => skip");
    assert.equal(cursors.migrations[ZCODE_PRUNE_WINDOW_RESTORE_KEY].skipped, true);

    // {skipped:true} must retry once a floor is known (do not delete the key).
    assert.equal(await repairZcodePruneWindowRestore({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), true);

    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const restored = rows.filter((entry) => entry.source === "zcode" && entry.hour_start === oldHour);
    assert.ok(restored.some((entry) => entry.total_tokens === 9000));
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${oldHour}`].totals.total_tokens, 9000);
    // In-window backup peak must not clobber the live higher value.
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${liveHour}`].totals.total_tokens, 80);
    assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
    assert.equal(cursors.migrations[ZCODE_PRUNE_WINDOW_RESTORE_KEY].restored, 1);

    assert.equal(await repairZcodePruneWindowRestore({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), false, "one-shot");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode restore re-appends when live queue retracted high→0 (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-high-zero-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const oldHour = "2026-09-01T09:00:00.000Z";
    const backupPath = `${queuePath}.bak.2026-10-17T00-00-00-000Z`;
    await fs.writeFile(backupPath, row("zcode", "GLM-5.2", oldHour, 9000) + "\n");
    // Historical peak 9000 then repair retraction 0 — last-wins is 0.
    await fs.writeFile(queuePath, [
      row("zcode", "GLM-5.2", oldHour, 9000),
      row("zcode", "GLM-5.2", oldHour, 0),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 50 }));
    const cursors = {
      hourly: {
        buckets: { [`zcode|GLM-5.2|${oldHour}`]: { totals: { total_tokens: 9000 } } },
        groupQueued: {},
      },
      migrations: {},
    };
    assert.equal(await repairZcodePruneWindowRestore({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), true);
    const rows = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const zcode = rows.filter((entry) => entry.source === "zcode" && entry.hour_start === oldHour);
    assert.equal(zcode.at(-1).total_tokens, 9000);
    assert.equal(cursors.migrations[ZCODE_PRUNE_WINDOW_RESTORE_KEY].restored, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode wipe skips floorless repair when only queue history exists (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-queue-only-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const hour = "2026-09-01T09:00:00.000Z";
    await fs.writeFile(queuePath, row("zcode", "GLM-5.2", hour, 5000) + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 10 }));
    const cursors = { migrations: {} };
    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: null,
    }), false);
    assert.equal(cursors.migrations.zcodeInclusiveTokenRepair_2026_09.skipped, true);
    assert.equal(JSON.parse((await fs.readFile(queuePath, "utf8")).trim()).total_tokens, 5000);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode wipe keeps pre-window message cursor to avoid double-count (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-cursor-keep-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const oldHour = "2026-09-01T09:00:00.000Z";
    const liveHour = "2026-10-10T09:00:00.000Z";
    await fs.writeFile(queuePath, [
      row("zcode", "GLM-5.2", oldHour, 5000),
      row("zcode", "GLM-5.2", liveHour, 100),
    ].join("\n") + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 1 }));
    const cursors = {
      zcode: {
        messages: {
          "old-session|msg-1": {
            lastTotals: { total_tokens: 5000 },
            attribution: `${oldHour}\tGLM-5.2\t\t`,
          },
          "live-session|msg-2": {
            lastTotals: { total_tokens: 100 },
            attribution: `${liveHour}\tGLM-5.2\t\t`,
          },
        },
      },
      hourly: {
        buckets: {
          [`zcode|GLM-5.2|${oldHour}`]: { totals: { total_tokens: 5000 } },
          [`zcode|GLM-5.2|${liveHour}`]: { totals: { total_tokens: 100 } },
        },
        groupQueued: {},
      },
      migrations: {},
    };
    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), true);
    assert.ok(cursors.zcode?.messages?.["old-session|msg-1"], "pre-window dedup kept");
    assert.equal(cursors.zcode.messages["live-session|msg-2"], undefined, "in-window cursor cleared");
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${oldHour}`].totals.total_tokens, 5000);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("zcode wipe keeps unattributed pre-window cursor to avoid double-count (#828)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tt-zcode-unattr-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const queueStatePath = path.join(tmp, "queue.state.json");
    const oldHour = "2026-09-01T09:00:00.000Z";
    await fs.writeFile(queuePath, row("zcode", "GLM-5.2", oldHour, 5000) + "\n");
    await fs.writeFile(queueStatePath, JSON.stringify({ offset: 1 }));
    const cursors = {
      zcode: {
        messages: {
          "old-session|msg-1": { lastTotals: { total_tokens: 5000 } },
        },
      },
      hourly: {
        buckets: { [`zcode|GLM-5.2|${oldHour}`]: { totals: { total_tokens: 5000 } } },
        groupQueued: {},
      },
      migrations: {},
    };
    assert.equal(await repairZcodeInclusiveTokenMigration({
      cursors,
      queuePath,
      queueStatePath,
      rebuildFloorMs: Date.parse("2026-09-17T00:00:00.000Z"),
    }), true);
    assert.ok(cursors.zcode?.messages?.["old-session|msg-1"], "unattributed pre-window kept");
    assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${oldHour}`].totals.total_tokens, 5000);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveZcodeRebuildFloorMs returns null without readable DBs", () => {
  assert.equal(resolveZcodeRebuildFloorMs([]), null);
  assert.equal(resolveZcodeRebuildFloorMs([path.join(os.tmpdir(), "missing-zcode.sqlite")]), null);
});

test("ZCode repair retains concurrent proxy appends and retries a failed upload-state write", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-zcode-retry-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const queuePath = path.join(tmp, "queue.jsonl");
  const queueStatePath = path.join(tmp, "queue.state.json");
  const hour = "2026-10-10T09:00:00Z";
  const initial = row("zcode", "GLM-5.2", hour, 100) + "\n";
  const proxy = row("cliproxy", "fixture-model", hour, 20) + "\n";
  await fs.writeFile(queuePath, initial);
  await fs.writeFile(queueStatePath, '{"offset":100}');
  const cursors = { zcode: { messages: { m: { attribution: `${hour}\tGLM-5.2\t\t` } } }, migrations: {} };
  const before = structuredClone(cursors);
  const appendFile = fs.appendFile;
  const append = t.mock.method(fs, "appendFile", async (file, ...args) => {
    if (file === queuePath) await appendFile(queuePath, proxy);
    return appendFile(file, ...args);
  });
  const writeFile = fs.writeFile;
  const failedWrite = t.mock.method(fs, "writeFile", async (file, ...args) => {
    if (file === queueStatePath) throw new Error("injected upload-state failure");
    return writeFile(file, ...args);
  });
  const options = { cursors, queuePath, queueStatePath, rebuildFloorMs: Date.parse(hour) };
  await assert.rejects(repairZcodeInclusiveTokenMigration(options), /upload-state failure/);
  assert.deepEqual(cursors, before, "failed repair must not commit cursor changes");
  const emitted = await fs.readFile(queuePath, "utf8");
  assert.ok(emitted.startsWith(initial + proxy));
  failedWrite.mock.restore();
  append.mock.restore();
  assert.equal(await repairZcodeInclusiveTokenMigration(options), true);
  assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
  const repaired = await fs.readFile(queuePath, "utf8");
  assert.equal(repaired.split("\n").filter(line => line === proxy.trim()).length, 1);
  assert.equal(await repairZcodeInclusiveTokenMigration(options), false);
  assert.equal(await fs.readFile(queuePath, "utf8"), repaired);
});

test("large ZCode repairs keep interleaved proxy rows valid across chunked writes", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-zcode-chunked-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const queuePath = path.join(tmp, "queue.jsonl");
  const hour = "2026-10-10T09:00:00Z";
  const initial = Array.from({ length: 3000 }, (_, i) => row("zcode", `fixture-${i}`, hour, 100)).join("\n") + "\n";
  await fs.writeFile(queuePath, initial);
  const proxy = row("cliproxy", "fixture-model", hour, 20) + "\n";
  const appendFile = fs.appendFile;
  let injected = false;
  t.mock.method(fs, "appendFile", async (file, data, ...args) => {
    if (file !== queuePath || injected) return appendFile(file, data, ...args);
    injected = true;
    // Node's asynchronous appendFile splits large buffers into 512 KiB writes.
    // The bridge can append a whole record between any two of those writes.
    const bytes = Buffer.from(data);
    const split = Math.min(512 * 1024, bytes.length);
    await appendFile(file, bytes.subarray(0, split));
    await appendFile(file, proxy);
    if (split < bytes.length) await appendFile(file, bytes.subarray(split));
  });
  const options = { cursors: { migrations: {} }, queuePath, rebuildFloorMs: Date.parse(hour) };
  assert.equal(await repairZcodeInclusiveTokenMigration(options), true);
  const repaired = await fs.readFile(queuePath, "utf8");
  const rows = repaired.trim().split("\n").map(JSON.parse);
  assert.ok(repaired.startsWith(initial));
  assert.equal(rows.filter(entry => entry.source === "cliproxy").length, 1);
  const latest = new Map(rows.filter(entry => entry.source === "zcode").map(entry => [entry.model, entry]));
  assert.equal(latest.size, 3000);
  assert.ok([...latest.values()].every(entry => entry.total_tokens === 0));
  assert.equal(await repairZcodeInclusiveTokenMigration(options), false);
  assert.equal(await fs.readFile(queuePath, "utf8"), repaired);
});

test("ZCode restore retries offset reset after a successful append without adding the peak twice", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-zcode-restore-retry-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const queuePath = path.join(tmp, "queue.jsonl");
  const queueStatePath = path.join(tmp, "queue.state.json");
  const hour = "2026-09-01T09:00:00Z";
  await fs.writeFile(`${queuePath}.bak.fixture`, row("zcode", "GLM-5.2", hour, 9000) + "\n");
  await fs.writeFile(queuePath, row("zcode", "GLM-5.2", hour, 0));
  await fs.writeFile(queueStatePath, '{"offset":100}');
  const cursors = { migrations: {} };
  const writeFile = fs.writeFile;
  const failedWrite = t.mock.method(fs, "writeFile", async (file, ...args) => {
    if (file === queueStatePath) throw new Error("injected upload-state failure");
    return writeFile(file, ...args);
  });
  const options = { cursors, queuePath, queueStatePath, rebuildFloorMs: Date.parse("2026-09-17T00:00:00Z") };
  await assert.rejects(repairZcodePruneWindowRestore(options), /upload-state failure/);
  assert.deepEqual(cursors, { migrations: {} });
  const appended = await fs.readFile(queuePath, "utf8");
  assert.equal(JSON.parse(appended.trim().split("\n").at(-1)).total_tokens, 9000);
  failedWrite.mock.restore();
  assert.equal(await repairZcodePruneWindowRestore(options), true);
  assert.equal(await fs.readFile(queuePath, "utf8"), appended);
  assert.equal(JSON.parse(await fs.readFile(queueStatePath, "utf8")).offset, 0);
  assert.equal(cursors.hourly.buckets[`zcode|GLM-5.2|${hour}`].totals.total_tokens, 9000);
  assert.equal(await repairZcodePruneWindowRestore(options), false);
});

test("native ZCode rebuild floors ignore old legacy rows, use the latest install floor, and defer unreadable installs", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-zcode-floors-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const SQL = await require("sql.js")();
  const create = async (name, startedAt) => {
    const db = new SQL.Database();
    db.exec(`CREATE TABLE model_usage (id TEXT, logical_request_id TEXT, attempt_index INTEGER, session_id TEXT, provider_id TEXT, model_id TEXT, status TEXT, started_at INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_updated INTEGER, data TEXT);`);
    db.run("INSERT INTO model_usage VALUES ('u', 'u', 0, 's', 'fixture', 'GLM-5.2', 'completed', ?, 100, 0, 0, 0, 0)", [startedAt]);
    db.run("INSERT INTO message VALUES ('m', 's', ?, ?)", [Date.parse("2026-01-01T00:00:00Z"), JSON.stringify({ role: "assistant", modelID: "GLM-5.2", tokens: { input: 50 } })]);
    const file = path.join(tmp, name);
    await fs.writeFile(file, db.export());
    db.close();
    return file;
  };
  const firstFloor = Date.parse("2026-09-17T00:00:00Z");
  const latestFloor = Date.parse("2026-09-20T00:00:00Z");
  const first = await create("first.db", firstFloor);
  const second = await create("second.db", latestFloor);
  assert.equal(resolveZcodeRebuildFloorMs([first]), firstFloor);
  assert.equal(resolveZcodeRebuildFloorMs([first, second]), latestFloor);
  const corrupt = path.join(tmp, "corrupt.db");
  await fs.writeFile(corrupt, "invalid sqlite");
  assert.equal(resolveZcodeRebuildFloorMs([first, corrupt]), null);
});

test("ZCode migration followed by two ledger scans preserves history and rebuilds live usage once", async (t) => {
  const { parseOpencodeDbIncremental } = require("../src/lib/rollout");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-zcode-rescan-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const queuePath = path.join(tmp, "queue.jsonl");
  const oldHour = "2026-09-01T09:00:00Z";
  const hour = "2026-10-10T09:00:00Z";
  await fs.writeFile(queuePath, [row("zcode", "GLM-5.2", oldHour, 5000), row("zcode", "GLM-5.2", hour, 999)].join("\n") + "\n");
  const cursors = { migrations: {}, hourly: { buckets: {}, groupQueued: {} } };
  await repairZcodeInclusiveTokenMigration({ cursors, queuePath, rebuildFloorMs: Date.parse(hour) });
  const dbMessages = [{ sessionID: "s", id: "m", timeUpdated: Date.parse(hour), data: {
    time: { completed: Date.parse(hour) },
    role: "assistant", modelID: "GLM-5.2", tokens: { input: 100, output: 20, cache: { read: 0, write: 0 } },
  } }];
  const scan = () => parseOpencodeDbIncremental({ dbMessages, dbPath: path.join(tmp, "fixture.db"), cursors, queuePath, source: "zcode", cursorKey: "zcode" });
  await scan();
  const once = await fs.readFile(queuePath, "utf8");
  await scan();
  assert.equal(await fs.readFile(queuePath, "utf8"), once);
  const latest = new Map(once.trim().split("\n").map(line => { const entry = JSON.parse(line); return [Date.parse(entry.hour_start), entry]; }));
  assert.equal(latest.get(Date.parse(oldHour)).total_tokens, 5000);
  assert.equal(latest.get(Date.parse(hour)).total_tokens, 120);
});
