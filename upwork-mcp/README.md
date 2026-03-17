# Upwork MCP Server

A Model Context Protocol (MCP) server for integrating Claude with your Upwork account.

## Features

| Tool | Description |
|---|---|
| `get_auth_url` | Generate OAuth2 URL to authorize access |
| `exchange_auth_code` | Exchange auth code for tokens |
| `get_my_profile` | View your freelancer profile |
| `search_jobs` | Search jobs by keyword, budget, type |
| `get_job_details` | Get full details of a job |
| `list_proposals` | View your submitted proposals |
| `submit_proposal` | Apply to a job |
| `list_contracts` | View active/past contracts |
| `get_earnings` | Earnings report for a date range |
| `list_messages` | List message conversations |
| `send_message` | Send a message to a client |
| `get_work_diary` | View time logs for a contract |
| `get_client_info` | Get info about a client |

## Setup

### 1. Create an Upwork App

1. Go to [Upwork Developer Center](https://www.upwork.com/developer/keys/apply)
2. Apply for API access and create an app
3. Note your **Client ID** and **Client Secret**

### 2. Install Dependencies

```bash
cd upwork-mcp
npm install
```

### 3. Configure Credentials

```bash
cp .env.example .env
```

Edit `.env` and fill in your `UPWORK_CLIENT_ID` and `UPWORK_CLIENT_SECRET`.

### 4. Authorize Your Account

Run the server and use these tools in sequence:

1. Call `get_auth_url` → visit the URL in your browser
2. After approving, copy the `code` from the redirect URL
3. Call `exchange_auth_code` with that code
4. Tokens are saved automatically to `.env`

### 5. Add to Claude Code

Add to your `~/.claude/claude_desktop_config.json` (or Claude Code settings):

```json
{
  "mcpServers": {
    "upwork": {
      "command": "node",
      "args": ["/absolute/path/to/upwork-mcp/src/index.js"]
    }
  }
}
```

Or use with the Claude Code CLI:

```bash
claude mcp add upwork -- node /absolute/path/to/upwork-mcp/src/index.js
```

## Usage Examples

Once connected, you can ask Claude:

- "Search for React developer jobs under $5000"
- "Show my active contracts"
- "List my pending proposals"
- "What did I earn last month?"
- "Send a message to room X saying..."

## Notes

- Upwork's API requires OAuth 2.0 — tokens auto-refresh when expired
- The `submit_proposal` tool posts real proposals; double-check before using
- API rate limits apply per Upwork's developer documentation
