/**
 * Scheduler — runs the agent on a cron schedule.
 * Default: every 6 hours. Override with AGENT_CRON env var.
 */

import cron from "node-cron";
import { runAgent } from "./agent.js";
import { createRunLogger } from "./logger.js";

function runId() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function executeRun(dryRun = false) {
  const id = runId();
  const logger = createRunLogger(id);
  logger.entry.dry_run = dryRun;

  logger.log(`═══ Starting run ${id} (dryRun=${dryRun}) ═══`);

  try {
    const summary = await runAgent({ dryRun, logger });

    logger.entry.jobs_found = summary.jobs_found;
    logger.entry.jobs_scored = summary.jobs_scored || [];
    logger.entry.proposals_submitted = summary.proposals_submitted || [];
    logger.entry.proposals_skipped = summary.proposals_skipped || [];

    logger.finish(summary.summary_text || "Run completed");

    console.log("\n════════════════════════════════════════");
    console.log(`RUN SUMMARY — ${id}`);
    console.log(`Jobs found:      ${summary.jobs_found}`);
    console.log(`Jobs scored:     ${summary.jobs_scored?.length || 0}`);
    console.log(`Proposals sent:  ${summary.proposals_submitted?.length || 0}${dryRun ? " (DRY RUN)" : ""}`);
    console.log(`Skipped:         ${summary.proposals_skipped?.length || 0}`);
    if (summary.profile_notes) console.log(`Profile notes:   ${summary.profile_notes}`);
    console.log(`Summary: ${summary.summary_text}`);
    console.log("════════════════════════════════════════\n");

    return summary;
  } catch (err) {
    logger.error(err.message);
    logger.finish(`Run failed: ${err.message}`);
    throw err;
  }
}

export function startScheduler(dryRun = false) {
  const cronExpr = process.env.AGENT_CRON || "0 */6 * * *";

  if (!cron.validate(cronExpr)) {
    console.error(`Invalid cron expression: "${cronExpr}"`);
    process.exit(1);
  }

  console.log(`Upwork Agent Scheduler started`);
  console.log(`Schedule: ${cronExpr}  (dry_run=${dryRun})`);
  console.log(`Press Ctrl+C to stop.\n`);

  // Run once immediately on start
  executeRun(dryRun).catch((err) => console.error("Initial run failed:", err.message));

  cron.schedule(cronExpr, () => {
    executeRun(dryRun).catch((err) => console.error("Scheduled run failed:", err.message));
  });
}

export { executeRun };
