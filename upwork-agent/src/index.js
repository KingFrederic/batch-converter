#!/usr/bin/env node
/**
 * Upwork Autonomous Agent — Entry Point
 *
 * Usage:
 *   node src/index.js              → start scheduler (runs every 6h by default)
 *   node src/index.js --once       → run once and exit
 *   node src/index.js --dry-run    → run once, no proposals submitted
 *   node src/index.js --schedule   → explicit scheduler start
 *   node src/index.js --history    → show last 5 run summaries
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    const val = t.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run") || process.env.DRY_RUN === "true";
const runOnce = args.includes("--once") || args.includes("--dry-run");
const showHistory = args.includes("--history");
const startSchedule = args.includes("--schedule") || (!runOnce && !showHistory);

// ── History mode ───────────────────────────────────────────────────────────────
if (showHistory) {
  const { readdirSync, existsSync: exists } = await import("fs");
  const runsDir = join(__dirname, "..", "runs");
  if (!exists(runsDir)) {
    console.log("No runs found yet.");
    process.exit(0);
  }
  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, 5);

  if (!files.length) {
    console.log("No runs found yet.");
    process.exit(0);
  }

  for (const f of files) {
    const run = JSON.parse(readFileSync(join(runsDir, f), "utf-8"));
    console.log(`\n── ${run.run_id} (${run.dry_run ? "dry-run" : "live"}) ──`);
    console.log(`  Started:    ${run.started_at}`);
    console.log(`  Jobs found: ${run.jobs_found}`);
    console.log(`  Proposals:  ${run.proposals_submitted?.length || 0}`);
    console.log(`  Errors:     ${run.errors?.length || 0}`);
    console.log(`  Summary:    ${run.summary}`);
  }
  process.exit(0);
}

// ── Run once ───────────────────────────────────────────────────────────────────
if (runOnce) {
  const { executeRun } = await import("./scheduler.js");
  try {
    await executeRun(isDryRun);
    process.exit(0);
  } catch (err) {
    console.error("Run failed:", err.message);
    process.exit(1);
  }
}

// ── Scheduler ──────────────────────────────────────────────────────────────────
if (startSchedule) {
  const { startScheduler } = await import("./scheduler.js");
  startScheduler(isDryRun);
}
