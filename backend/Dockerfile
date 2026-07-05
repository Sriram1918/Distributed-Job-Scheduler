# Single backend image; the run mode (api/worker/scheduler/reaper) is chosen
# by the "command" in docker-compose. Uses tsx to run TypeScript directly.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install

# Application source.
COPY tsconfig.json ./
COPY src ./src

# Default mode; overridden per-service in docker-compose.
CMD ["npm", "run", "api"]
