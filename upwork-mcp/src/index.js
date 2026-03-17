import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load .env if present
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", ".env");
if (existsSync(envPath)) {
  const envFile = readFileSync(envPath, "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const BASE_URL = "https://api.upwork.com";

// ── Token Management ──────────────────────────────────────────────────────────

let tokens = {
  accessToken: process.env.UPWORK_ACCESS_TOKEN || "",
  refreshToken: process.env.UPWORK_REFRESH_TOKEN || "",
  expiry: Number(process.env.UPWORK_TOKEN_EXPIRY || 0),
};

function persistTokens() {
  if (!existsSync(envPath)) return;
  let content = readFileSync(envPath, "utf-8");
  const replace = (key, val) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  };
  replace("UPWORK_ACCESS_TOKEN", tokens.accessToken);
  replace("UPWORK_REFRESH_TOKEN", tokens.refreshToken);
  replace("UPWORK_TOKEN_EXPIRY", String(tokens.expiry));
  writeFileSync(envPath, content);
}

async function refreshAccessToken() {
  if (!tokens.refreshToken) throw new Error("No refresh token available. Run the auth flow first.");
  const resp = await axios.post(
    `${BASE_URL}/api/v3/oauth2/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }),
    {
      auth: {
        username: process.env.UPWORK_CLIENT_ID,
        password: process.env.UPWORK_CLIENT_SECRET,
      },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );
  tokens.accessToken = resp.data.access_token;
  tokens.refreshToken = resp.data.refresh_token || tokens.refreshToken;
  tokens.expiry = Date.now() + resp.data.expires_in * 1000;
  persistTokens();
  return tokens.accessToken;
}

async function getAccessToken() {
  if (!tokens.accessToken) throw new Error("No access token. Add UPWORK_ACCESS_TOKEN to .env");
  if (Date.now() >= tokens.expiry - 60_000) {
    return await refreshAccessToken();
  }
  return tokens.accessToken;
}

// ── HTTP Client ───────────────────────────────────────────────────────────────

async function upworkGet(path, params = {}) {
  const token = await getAccessToken();
  const resp = await axios.get(`${BASE_URL}${path}`, {
    params,
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.data;
}

async function upworkPost(path, data = {}) {
  const token = await getAccessToken();
  const resp = await axios.post(`${BASE_URL}${path}`, data, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return resp.data;
}

async function upworkPut(path, data = {}) {
  const token = await getAccessToken();
  const resp = await axios.put(`${BASE_URL}${path}`, data, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return resp.data;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "upwork",
  version: "1.0.0",
});

// ── Tool: get_auth_url ────────────────────────────────────────────────────────

server.tool(
  "get_auth_url",
  "Generate the Upwork OAuth2 authorization URL to get access tokens.",
  {
    redirect_uri: z
      .string()
      .default("https://localhost:3000/callback")
      .describe("OAuth redirect URI (must match your app settings)"),
  },
  async ({ redirect_uri }) => {
    const clientId = process.env.UPWORK_CLIENT_ID;
    if (!clientId) return { content: [{ type: "text", text: "Error: UPWORK_CLIENT_ID not set in .env" }] };
    const url = new URL(`${BASE_URL}/api/v3/oauth2/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirect_uri);
    return {
      content: [
        {
          type: "text",
          text: `Visit this URL to authorize:\n\n${url.toString()}\n\nAfter approving, you'll get a code. Use exchange_auth_code with that code.`,
        },
      ],
    };
  }
);

// ── Tool: exchange_auth_code ──────────────────────────────────────────────────

server.tool(
  "exchange_auth_code",
  "Exchange an OAuth2 authorization code for access/refresh tokens.",
  {
    code: z.string().describe("The authorization code from the OAuth callback"),
    redirect_uri: z
      .string()
      .default("https://localhost:3000/callback")
      .describe("Must match the redirect URI used in get_auth_url"),
  },
  async ({ code, redirect_uri }) => {
    const clientId = process.env.UPWORK_CLIENT_ID;
    const clientSecret = process.env.UPWORK_CLIENT_SECRET;
    if (!clientId || !clientSecret)
      return { content: [{ type: "text", text: "Error: UPWORK_CLIENT_ID or UPWORK_CLIENT_SECRET not set" }] };
    try {
      const resp = await axios.post(
        `${BASE_URL}/api/v3/oauth2/token`,
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri,
        }),
        {
          auth: { username: clientId, password: clientSecret },
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }
      );
      tokens.accessToken = resp.data.access_token;
      tokens.refreshToken = resp.data.refresh_token;
      tokens.expiry = Date.now() + resp.data.expires_in * 1000;
      persistTokens();
      return {
        content: [
          {
            type: "text",
            text: `Tokens saved successfully!\nAccess token expires in ${Math.round(resp.data.expires_in / 60)} minutes.\nTokens have been persisted to .env`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Tool: get_my_profile ──────────────────────────────────────────────────────

server.tool(
  "get_my_profile",
  "Get your Upwork freelancer profile including skills, title, and overview.",
  {},
  async () => {
    try {
      const data = await upworkGet("/api/profiles/v2/users/~");
      const u = data.profile || data;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(u, null, 2),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Tool: search_jobs ─────────────────────────────────────────────────────────

server.tool(
  "search_jobs",
  "Search for jobs on Upwork by keyword, category, budget, and more.",
  {
    q: z.string().describe("Search query / keywords"),
    category2: z.string().optional().describe("Category name (e.g. 'Web Development')"),
    budget_min: z.number().optional().describe("Minimum budget (USD)"),
    budget_max: z.number().optional().describe("Maximum budget (USD)"),
    duration: z
      .enum(["week", "month", "semester", "ongoing"])
      .optional()
      .describe("Project duration filter"),
    job_type: z.enum(["hourly", "fixed"]).optional().describe("Job type"),
    paging: z
      .string()
      .default("0;10")
      .describe("Pagination in format 'offset;count' (e.g. '0;20')"),
    sort: z
      .enum(["recency", "relevance", "client_rating", "client_total_charge"])
      .default("recency")
      .describe("Sort order"),
  },
  async ({ q, category2, budget_min, budget_max, duration, job_type, paging, sort }) => {
    try {
      const params = { q, paging, sort };
      if (category2) params["category2"] = category2;
      if (budget_min != null) params["budget[0]"] = budget_min;
      if (budget_max != null) params["budget[1]"] = budget_max;
      if (duration) params["duration"] = duration;
      if (job_type) params["job_type"] = job_type;

      const data = await upworkGet("/api/jobs/v2/search/jobs/", params);
      const jobs = data.jobs || [];
      if (!jobs.length) return { content: [{ type: "text", text: "No jobs found." }] };

      const summary = jobs.map((j, i) => {
        const budget =
          j.budget?.amount != null
            ? `$${j.budget.amount}`
            : j.hourly_budget_min != null
            ? `$${j.hourly_budget_min}-$${j.hourly_budget_max}/hr`
            : "N/A";
        return [
          `${i + 1}. ${j.title}`,
          `   ID: ${j.id}`,
          `   Budget: ${budget}  |  Type: ${j.job_type || "N/A"}`,
          `   Posted: ${j.date_created}`,
          `   Skills: ${(j.skills || []).join(", ") || "N/A"}`,
          `   ${(j.snippet || "").slice(0, 120)}...`,
        ].join("\n");
      });

      return {
        content: [
          {
            type: "text",
            text: `Found ${data.paging?.total || jobs.length} jobs (showing ${jobs.length}):\n\n${summary.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Tool: get_job_details ─────────────────────────────────────────────────────

server.tool(
  "get_job_details",
  "Get full details of a specific Upwork job by its ID.",
  {
    job_id: z.string().describe("The Upwork job ID (from search results)"),
  },
  async ({ job_id }) => {
    try {
      const data = await upworkGet(`/api/jobs/v2/postings/${job_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Tool: list_proposals ──────────────────────────────────────────────────────

server.tool(
  "list_proposals",
  "List your submitted job proposals/applications on Upwork.",
  {
    status: z
      .enum(["active", "archived", "declined"])
      .optional()
      .describe("Filter by proposal status"),
    paging: z.string().default("0;10").describe("Pagination 'offset;count'"),
  },
  async ({ status, paging }) => {
    try {
      const params = { paging };
      if (status) params["status"] = status;
      const data = await upworkGet("/api/hr/v2/proposals/", params);
      const proposals = data.proposals || [];
      if (!proposals.length) return { content: [{ type: "text", text: "No proposals found." }] };

      const lines = proposals.map((p, i) => {
        return [
          `${i + 1}. Job: ${p.job_ref_ciphertext || p.job_ref || "N/A"}`,
          `   Ref: ${p.reference}`,
          `   Status: ${p.status}`,
          `   Bid: $${p.bid_amount || "N/A"}`,
          `   Created: ${p.created}`,
        ].join("\n");
      });

      return {
        content: [
          { type: "text", text: `Your proposals:\n\n${lines.join("\n\n")}` },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Tool: submit_proposal ─────────────────────────────────────────────────────

server.tool(
  "submit_proposal",
  "Submit a proposal (application) to an Upwork job.",
  {
    job_id: z.string().describe("The job ID to apply to"),
    cover_letter: z.string().describe("Your cover letter text"),
    bid_amount: z.number().describe("Your bid amount in USD"),
    bid_type: z.enum(["hourly", "fixed"]).describe("Bid type matching the job type"),
    estimated_duration: z
      .string()
      .optional()
      .describe("Estimated hours (for hourly jobs)"),
  },
  async ({ job_id, cover_letter, bid_amount, bid_type, estimated_duration }) => {
    try {
      const payload = {
        job_ref_ciphertext: job_id,
        cover_letter,
        bid_amount,
        bid_type,
      };
      if (estimated_duration) payload.estimated_duration = estimated_duration;
      const data = await upworkPost("/api/hr/v2/proposals/", payload);
      return {
        content: [
          { type: "text", text: `Proposal submitted!\n${JSON.stringify(data, null, 2)}` },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Tool: list_contracts ──────────────────────────────────────────────────────

server.tool(
  "list_contracts",
  "List your active and past contracts on Upwork.",
  {
    status: z
      .enum(["active", "closed"])
      .default("active")
      .describe("Contract status filter"),
    paging: z.string().default("0;10").describe("Pagination 'offset;count'"),
  },
  async ({ status, paging }) => {
    try {
      const data = await upworkGet("/api/hr/v2/contracts/", { status, paging });
      const contracts = data.contracts || [];
      if (!contracts.length) return { content: [{ type: "text", text: "No contracts found." }] };

      const lines = contracts.map((c, i) => {
        return [
          `${i + 1}. ${c.job_title || "N/A"}`,
          `   Contract ID: ${c.reference}`,
          `   Client: ${c.buyer_team?.name || "N/A"}`,
          `   Status: ${c.status}`,
          `   Rate: ${c.hourly_pay_rate ? `$${c.hourly_pay_rate}/hr` : c.fixed_pay_amount ? `$${c.fixed_pay_amount} fixed` : "N/A"}`,
          `   Started: ${c.start_date || "N/A"}`,
        ].join("\n");
      });

      return {
        content: [
          { type: "text", text: `Contracts (${status}):\n\n${lines.join("\n\n")}` },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Tool: get_earnings ────────────────────────────────────────────────────────

server.tool(
  "get_earnings",
  "Get your Upwork earnings report for a date range.",
  {
    from_date: z.string().describe("Start date in YYYY-MM-DD format"),
    to_date: z.string().describe("End date in YYYY-MM-DD format"),
  },
  async ({ from_date, to_date }) => {
    try {
      const data = await upworkGet("/api/reports/v1/earnings/user/~.json", {
        tq: `SELECT earning_date, amount, type, assignment__title WHERE earning_date >= '${from_date}' AND earning_date <= '${to_date}'`,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Tool: list_messages ───────────────────────────────────────────────────────

server.tool(
  "list_messages",
  "List your Upwork message rooms/conversations.",
  {
    paging: z.string().default("1;10").describe("Pagination 'page;per_page'"),
  },
  async ({ paging }) => {
    try {
      const [page, perPage] = paging.split(";").map(Number);
      const data = await upworkGet("/api/messages/v3/rooms", {
        page: page || 1,
        per_page: perPage || 10,
      });
      const rooms = data.rooms || [];
      if (!rooms.length) return { content: [{ type: "text", text: "No conversations found." }] };

      const lines = rooms.map((r, i) => {
        return [
          `${i + 1}. Room: ${r.id}`,
          `   Topic: ${r.topic || "N/A"}`,
          `   Last message: ${r.last_message?.message?.slice(0, 80) || "N/A"}`,
          `   Updated: ${r.last_message?.created || "N/A"}`,
        ].join("\n");
      });

      return {
        content: [{ type: "text", text: `Conversations:\n\n${lines.join("\n\n")}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Tool: send_message ────────────────────────────────────────────────────────

server.tool(
  "send_message",
  "Send a message in an Upwork conversation room.",
  {
    room_id: z.string().describe("The room/conversation ID (from list_messages)"),
    message: z.string().describe("The message text to send"),
  },
  async ({ room_id, message }) => {
    try {
      const data = await upworkPost(`/api/messages/v3/rooms/${room_id}/stories`, {
        message,
      });
      return {
        content: [
          { type: "text", text: `Message sent!\n${JSON.stringify(data, null, 2)}` },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Tool: get_work_diary ──────────────────────────────────────────────────────

server.tool(
  "get_work_diary",
  "Get your Upwork work diary (time logs) for a specific contract and week.",
  {
    contract_id: z.string().describe("Contract reference ID"),
    week_start: z.string().describe("Week start date (YYYY-MM-DD, must be a Monday)"),
  },
  async ({ contract_id, week_start }) => {
    try {
      const data = await upworkGet(
        `/api/team/v1/workdiaries/contracts/${contract_id}/${week_start}.json`
      );
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Tool: get_client_info ─────────────────────────────────────────────────────

server.tool(
  "get_client_info",
  "Get information about an Upwork client by their user ID.",
  {
    user_id: z.string().describe("Client user ID or '~' for your own info"),
  },
  async ({ user_id }) => {
    try {
      const data = await upworkGet(`/api/profiles/v2/users/${user_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.response?.data?.message || err.message}` }] };
    }
  }
);

// ── Start Server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
