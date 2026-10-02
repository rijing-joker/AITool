#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sqlPath = path.join(__dirname, "../../db/usage-daily-rollup-backfill.sql");
const sql = fs.readFileSync(sqlPath, "utf8");

const forcesUtc = /perform\s+set_config\('TimeZone',\s*'UTC',\s*true\)/i.test(sql);
const hasUtcStart = forcesUtc && /hour_start\s*>=\s*p_from::timestamptz/i.test(sql);
const hasUtcEnd = forcesUtc && /hour_start\s*<\s*\(p_to\s*\+\s*1\)::timestamptz/i.test(sql);

assert.ok(hasUtcStart, "backfill start boundary must be UTC-based");
assert.ok(hasUtcEnd, "backfill end boundary must be UTC-based");

process.stdout.write(JSON.stringify({ ok: true }) + "\n");
