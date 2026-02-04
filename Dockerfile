# Multi-stage Docker build for codedev-mcp
# Security: non-root user, minimal attack surface, SBOM support

# === Build stage ===
FROM node:22-alpine AS builder
WORKDIR /app

# Install deps first (cache layer)
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# === Runtime stage ===
FROM node:22-alpine AS runtime

# Install ripgrep and git for full functionality
RUN apk add --no-cache ripgrep git

# Create non-root user
RUN addgroup -g 1001 codedev && \
    adduser -u 1001 -G codedev -s /bin/sh -D codedev

WORKDIR /app

# Copy only production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Install tini for proper signal handling (clean shutdown when IDE closes)
RUN apk add --no-cache tini

# The MCP server communicates via stdio
# Mount your project directory as /workspace
ENV CODEDEV_MCP_CWD=/workspace

# Set ownership again just in case
RUN chown -R codedev:codedev /app

# Switch to non-root user
USER codedev

ENTRYPOINT ["tini", "--", "node", "dist/index.js"]
