FROM node:22-slim

WORKDIR /app

# Copy relay package files (paths relative to repo root — Railway uses repo root as context)
COPY relay/package.json relay/package-lock.json ./

# Install all deps (including devDependencies for tsc build)
RUN npm ci

# Copy source
COPY relay/tsconfig.json ./
COPY relay/src ./src

# Build TypeScript
RUN npx tsc

# Prune devDependencies for smaller image
RUN npm prune --production

EXPOSE 3000

CMD ["node", "dist/index.js"]
