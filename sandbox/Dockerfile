FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install agent CLIs globally
RUN npm install -g @anthropic-ai/claude-code @openai/codex tsx

# Set up workspace
WORKDIR /app

# Copy adapter workspace (self-contained pnpm workspace)
COPY adapter/ ./adapter/

# Install adapter workspace dependencies
WORKDIR /app/adapter
RUN pnpm install --frozen-lockfile

# Create workspace directory for agent operations
RUN mkdir -p /workspace
WORKDIR /workspace

# The entry point is adapter-runner invoked via execd, not a container CMD
# But provide a default that verifies the image is functional
CMD ["node", "--version"]
