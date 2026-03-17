/**
 * Core autonomous agent.
 *
 * Flow:
 *  1. Spawn the Upwork MCP server as a subprocess
 *  2. List its tools and convert them to Anthropic tool format
 *  3. Run a multi-turn Claude loop with adaptive thinking
 *  4. Claude searches jobs, scores them, writes cover letters, submits proposals
 *  5. Return a structured run summary
 */

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config helpers ─────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = join(__dirname, "..", ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    const val = t.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

function loadPreferences() {
  const p = join(__dirname, "..", "preferences.json");
  return JSON.parse(readFileSync(p, "utf-8"));
}

// ── MCP → Anthropic tool converter ────────────────────────────────────────────

function mcpToolsToAnthropic(mcpTools) {
  return mcpTools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema || { type: "object", properties: {} },
  }));
}

// ── System prompt ──────────────────────────────────────────────────────────────

function buildSystemPrompt(prefs, dryRun) {
  const { profile, job_search, scoring, cover_letter } = prefs;
  return `You are an autonomous Upwork account manager acting on behalf of a freelancer.
Your job is to:
  1. Fetch the freelancer's current Upwork profile
  2. Search for relevant jobs using the provided preferences
  3. Score each job 1–10 based on fit (skills match, budget, client rating, description quality)
  4. For jobs scoring ${scoring.auto_apply_threshold}+ out of 10, write a tailored cover letter and${dryRun ? " [DRY RUN: log but DO NOT submit]" : " submit a proposal"}
  5. Report what you did

━━━ FREELANCER PROFILE ━━━
Title: ${profile.title}
Skills: ${profile.skills.join(", ")}
Hourly rate: $${profile.hourly_rate_usd}/hr
Bio: ${profile.bio_summary}
Portfolio highlights:
${profile.portfolio_highlights.map((h) => `  • ${h}`).join("\n")}

━━━ JOB SEARCH PREFERENCES ━━━
Search queries: ${job_search.queries.join(", ")}
Job types: ${job_search.job_types.join(", ")}
Min budget: $${job_search.budget_min_usd}
Min hourly rate: $${job_search.hourly_rate_min_usd}/hr
Results per query: ${job_search.results_per_query}

━━━ SCORING RULES ━━━
Auto-apply threshold: ${scoring.auto_apply_threshold}/10
Max proposals per run: ${scoring.max_proposals_per_run}
Skip unverified payment: ${scoring.skip_if_no_payment_verified}
Avoid keywords: ${scoring.avoid_keywords.join(", ")}

━━━ COVER LETTER STYLE ━━━
Tone: ${cover_letter.tone}
Max length: ${cover_letter.max_length_words} words
Instructions: ${cover_letter.custom_instructions}

━━━ RULES ━━━
- Search all queries, deduplicate by job ID
- Score EVERY job before deciding to apply
- Never apply to the same job twice (check existing proposals first)
- Always use get_my_profile first to understand the current profile state
- If DRY RUN mode: log proposals with score and cover letter but call NO submit tools
- After completing your work, output a JSON block with this exact format:
  <summary>
  {
    "jobs_found": <number>,
    "jobs_scored": [{"id": "...", "title": "...", "score": 8, "reason": "..."}],
    "proposals_submitted": [{"job_id": "...", "title": "...", "bid": 0, "score": 0}],
    "proposals_skipped": [{"job_id": "...", "title": "...", "score": 5, "reason": "..."}],
    "profile_notes": "any observations about profile that could be improved",
    "summary_text": "2-3 sentence plain summary of this run"
  }
  </summary>
${dryRun ? "\n⚠️  DRY RUN MODE ACTIVE — Do not call submit_proposal." : ""}`;
}

// ── Main agent loop ────────────────────────────────────────────────────────────

export async function runAgent({ dryRun = false, logger } = {}) {
  loadEnv();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in .env");

  const mcpPath = resolve(
    __dirname,
    "..",
    process.env.UPWORK_MCP_PATH || "../upwork-mcp/src/index.js"
  );
  if (!existsSync(mcpPath)) throw new Error(`MCP server not found at: ${mcpPath}`);

  const prefs = loadPreferences();
  const anthropic = new Anthropic({ apiKey });

  logger?.log(`Starting agent run (dryRun=${dryRun})`);
  logger?.log(`Connecting to MCP server: ${mcpPath}`);

  // ── Connect to MCP ──
  const transport = new StdioClientTransport({ command: "node", args: [mcpPath] });
  const mcp = new Client({ name: "upwork-agent", version: "1.0.0" });

  try {
    await mcp.connect(transport);
  } catch (err) {
    throw new Error(`Failed to connect to Upwork MCP: ${err.message}`);
  }

  let mcpTools = [];
  try {
    const { tools } = await mcp.listTools();
    mcpTools = tools;
    logger?.log(`MCP tools available: ${mcpTools.map((t) => t.name).join(", ")}`);
  } catch (err) {
    throw new Error(`Failed to list MCP tools: ${err.message}`);
  }

  const anthropicTools = mcpToolsToAnthropic(mcpTools);
  const systemPrompt = buildSystemPrompt(prefs, dryRun);

  // ── Agentic loop ──
  const messages = [
    {
      role: "user",
      content: `Run a full Upwork job search and apply cycle now. Today is ${new Date().toUTCString()}.`,
    },
  ];

  let runSummary = null;
  let iterations = 0;
  const MAX_ITERATIONS = 30; // safety cap

  logger?.log("Starting Claude agentic loop...");

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    let response;
    try {
      // Stream for visibility, collect final message
      const stream = anthropic.messages.stream({
        model: "claude-opus-4-6",
        max_tokens: 8192,
        thinking: { type: "adaptive" },
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      });

      // Log streamed text to console in real time
      stream.on("text", (delta) => process.stdout.write(delta));

      response = await stream.finalMessage();
    } catch (err) {
      logger?.error(`Anthropic API error: ${err.message}`);
      throw err;
    }

    // Append assistant turn
    messages.push({ role: "assistant", content: response.content });

    // Extract summary from text if present
    for (const block of response.content) {
      if (block.type === "text") {
        const match = block.text.match(/<summary>([\s\S]*?)<\/summary>/);
        if (match) {
          try {
            runSummary = JSON.parse(match[1].trim());
          } catch {
            // not valid JSON yet, keep going
          }
        }
      }
    }

    // Done — no more tool calls
    if (response.stop_reason === "end_turn") {
      logger?.log("Agent completed (end_turn)");
      break;
    }

    // Handle tool calls
    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      const toolResults = [];

      for (const block of toolUseBlocks) {
        const toolName = block.name;
        const toolInput = block.input;

        // In dry run, intercept submit_proposal
        if (dryRun && toolName === "submit_proposal") {
          logger?.log(`[DRY RUN] Would submit proposal: ${JSON.stringify(toolInput)}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({
              dry_run: true,
              message: "DRY RUN: proposal NOT submitted",
              would_have_submitted: toolInput,
            }),
          });
          continue;
        }

        logger?.log(`Calling tool: ${toolName}(${JSON.stringify(toolInput).slice(0, 120)})`);

        let result;
        try {
          const mcpResult = await mcp.callTool({ name: toolName, arguments: toolInput });
          result = JSON.stringify(mcpResult.content?.[0]?.text ?? mcpResult);
        } catch (err) {
          result = JSON.stringify({ error: err.message });
          logger?.error(`Tool ${toolName} failed: ${err.message}`);
        }

        // Log meaningful events
        if (toolName === "submit_proposal") {
          logger?.log(`PROPOSAL SUBMITTED: job=${toolInput.job_id} bid=$${toolInput.bid_amount}`);
          logger?.entry && logger.addProposal({
            job_id: toolInput.job_id,
            bid_amount: toolInput.bid_amount,
            submitted_at: new Date().toISOString(),
          });
        }

        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // pause_turn: server loop hit limit, re-send to continue
    if (response.stop_reason === "pause_turn") {
      logger?.log("pause_turn received, continuing...");
      continue;
    }

    break;
  }

  if (iterations >= MAX_ITERATIONS) {
    logger?.log(`Warning: hit max iterations (${MAX_ITERATIONS})`);
  }

  // ── Clean up MCP ──
  try {
    await mcp.close();
  } catch {}

  // Build final summary
  if (!runSummary) {
    runSummary = {
      jobs_found: 0,
      jobs_scored: [],
      proposals_submitted: [],
      proposals_skipped: [],
      profile_notes: "",
      summary_text: "Run completed but no structured summary was produced.",
    };
  }

  return runSummary;
}
