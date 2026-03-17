FROM node:20-alpine

WORKDIR /app

# Install dependencies for both packages
COPY upwork-mcp/package*.json ./upwork-mcp/
COPY upwork-agent/package*.json ./upwork-agent/

RUN cd upwork-mcp && npm ci --omit=dev
RUN cd upwork-agent && npm ci --omit=dev

# Copy source
COPY upwork-mcp/ ./upwork-mcp/
COPY upwork-agent/ ./upwork-agent/

# Set working directory to agent
WORKDIR /app/upwork-agent

# Health check via log file presence
HEALTHCHECK --interval=5m --timeout=10s \
  CMD test -d /app/upwork-agent/runs || exit 1

CMD ["node", "src/index.js", "--schedule"]
