import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(__dirname, "..", "runs");

if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });

export function createRunLogger(runId) {
  const logPath = join(RUNS_DIR, `${runId}.json`);
  const consolePath = join(RUNS_DIR, `${runId}.log`);

  const entry = {
    run_id: runId,
    started_at: new Date().toISOString(),
    finished_at: null,
    dry_run: false,
    jobs_found: 0,
    jobs_scored: [],
    proposals_submitted: [],
    proposals_skipped: [],
    profile_updates: [],
    errors: [],
    summary: "",
  };

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
      writeFileSync(consolePath, line + "\n", { flag: "a" });
    } catch {}
  };

  const save = () => {
    try {
      writeFileSync(logPath, JSON.stringify(entry, null, 2));
    } catch {}
  };

  return {
    log,
    entry,
    finish(summary) {
      entry.finished_at = new Date().toISOString();
      entry.summary = summary;
      save();
      log(`Run finished. Summary: ${summary}`);
    },
    error(msg) {
      entry.errors.push({ time: new Date().toISOString(), message: msg });
      log(`ERROR: ${msg}`);
      save();
    },
    addJob(job) {
      entry.jobs_scored.push(job);
      save();
    },
    addProposal(proposal) {
      entry.proposals_submitted.push(proposal);
      save();
    },
    skipProposal(job, reason) {
      entry.proposals_skipped.push({ job, reason });
      save();
    },
    path: logPath,
  };
}

export function getRunHistory(limit = 10) {
  try {
    const files = require("fs")
      .readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, limit);
    return files.map((f) => {
      try {
        return JSON.parse(readFileSync(join(RUNS_DIR, f), "utf-8"));
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function generateDailySummary() {
  const today = new Date().toISOString().slice(0, 10);
  const allRuns = (() => {
    try {
      const { readdirSync } = await import("fs");
      return readdirSync(RUNS_DIR)
        .filter((f) => f.startsWith(today) && f.endsWith(".json"))
        .map((f) => {
          try {
            return JSON.parse(readFileSync(join(RUNS_DIR, f), "utf-8"));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  })();

  const totalProposals = allRuns.reduce(
    (s, r) => s + (r.proposals_submitted?.length || 0),
    0
  );
  const totalJobs = allRuns.reduce(
    (s, r) => s + (r.jobs_scored?.length || 0),
    0
  );

  return {
    date: today,
    runs: allRuns.length,
    jobs_evaluated: totalJobs,
    proposals_submitted: totalProposals,
    runs_detail: allRuns,
  };
}
