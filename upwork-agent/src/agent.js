/**
 * Core autonomous agent.
 *
 * Flow:
 *  1. Spawn the Upwork MCP server as a subprocess
 *  2. List its tools and convert them to OpenAI/Groq tool format
 *  3. Run a multi-turn agentic loop powered by Groq (free tier, Llama 3.3 70B)
 *  4. The model searches jobs, scores them, writes cover letters, submits proposals
 *  5. Return a structured run summary
 */

import OpenAI from "openai";
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

function loadPreferences() {
  const p = join(__dirname, "..", "preferences.json");
  return JSON.parse(readFileSync(p, "utf-8"));
}

// ── MCP → OpenAI tool converter ────────────────────────────────────────────────

function mcpToolsToOpenAI(mcpTools) {
  return mcpTools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set in .env");

  const mcpPath = resolve(
    __dirname,
    "..",
    process.env.UPWORK_MCP_PATH || "../upwork-mcp/src/index.js"
  );
  if (!existsSync(mcpPath)) throw new Error(`MCP server not found at: ${mcpPath}`);

  const prefs = loadPreferences();

  // Groq via OpenAI-compatible API (free tier)
  const groq = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });

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

  const openaiTools = mcpToolsToOpenAI(mcpTools);
  const systemPrompt = buildSystemPrompt(prefs, dryRun);

  // ── Agentic loop ──
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Run a full Upwork job search and apply cycle now. Today is ${new Date().toUTCString()}.`,
    },
  ];

  let runSummary = null;
  let iterations = 0;
  const MAX_ITERATIONS = 30;

  logger?.log("Starting Groq (Llama 3.3 70B) agentic loop...");

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    let response;
    try {
      response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        max_tokens: 8192,
        tools: openaiTools,
        tool_choice: "auto",
        messages,
      });
    } catch (err) {
      logger?.error(`Groq API error: ${err.message}`);
      throw err;
    }

    const choice = response.choices[0];
    const assistantMsg = choice.message;

    // Print any text output
    if (assistantMsg.content) {
      process.stdout.write(assistantMsg.content + "\n");
    }

    // Append assistant turn
    messages.push(assistantMsg);

    // Extract summary from text if present
    if (assistantMsg.content) {
      const match = assistantMsg.content.match(/<summary>([\s\S]*?)<\/summary>/);
      if (match) {
        try {
          runSummary = JSON.parse(match[1].trim());
        } catch {
          // not valid JSON yet, keep going
        }
      }
    }

    // Done — no tool calls
    if (choice.finish_reason === "stop") {
      logger?.log("Agent completed (stop)");
      break;
    }

    // Handle tool calls
    if (choice.finish_reason === "tool_calls" && assistantMsg.tool_calls?.length) {
      const toolResults = [];

      for (const toolCall of assistantMsg.tool_calls) {
        const toolName = toolCall.function.name;
        let toolInput;
        try {
          toolInput = JSON.parse(toolCall.function.arguments);
        } catch {
          toolInput = {};
        }

        // In dry run, intercept submit_proposal
        if (dryRun && toolName === "submit_proposal") {
          logger?.log(`[DRY RUN] Would submit proposal: ${JSON.stringify(toolInput)}`);
          toolResults.push({
            role: "tool",
            tool_call_id: toolCall.id,
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

        if (toolName === "submit_proposal") {
          logger?.log(`PROPOSAL SUBMITTED: job=${toolInput.job_id} bid=$${toolInput.bid_amount}`);
          logger?.addProposal?.({
            job_id: toolInput.job_id,
            bid_amount: toolInput.bid_amount,
            submitted_at: new Date().toISOString(),
          });
        }

        toolResults.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      messages.push(...toolResults);
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
