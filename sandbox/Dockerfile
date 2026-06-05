FROM node:22

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

# Install agent CLIs globally
RUN npm install -g @anthropic-ai/claude-code @openai/codex @earendil-works/pi-coding-agent tsx

# Set up workspace
WORKDIR /app

# Copy adapter workspace (self-contained pnpm workspace)
COPY adapter/ ./adapter/

# Install adapter workspace dependencies
WORKDIR /app/adapter
ENV CI=true
RUN pnpm install --frozen-lockfile

# Create workspace directory for agent operations
RUN mkdir -p /workspace
WORKDIR /workspace

# The entry point is adapter-runner invoked via execd, not a container CMD
# But provide a default that verifies the image is functional
CMD ["node", "--version"]
