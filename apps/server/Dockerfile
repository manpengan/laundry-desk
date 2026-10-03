FROM node:22-bookworm-slim AS build

WORKDIR /workspace

RUN corepack enable
RUN apt-get update && apt-get install --no-install-recommends --yes python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches patches
COPY apps/server/package.json apps/server/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/platform-fs/package.json packages/platform-fs/package.json
COPY tools/migrate-v1/package.json tools/migrate-v1/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts \
  --filter @laundry/server... \
  --filter @laundry/platform-fs...

COPY apps/server apps/server
COPY packages/config/tsconfig packages/config/tsconfig
COPY packages/contracts packages/contracts
COPY packages/domain packages/domain
COPY packages/platform-fs packages/platform-fs
COPY tools/migrate-v1 tools/migrate-v1
COPY packages/db/src/migrations packages/db/src/migrations

RUN pnpm --filter @laundry/platform-fs build \
  && pnpm --filter @laundry/migrate-v1 rebuild better-sqlite3 \
  && pnpm --filter @laundry/migrate-v1 exec node --input-type=module -e 'import Database from "better-sqlite3"; const db = new Database(":memory:"); db.prepare("SELECT 1").get(); db.close();' \
  && NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @laundry/server... build

COPY tools/compose tools/compose

FROM node:22-bookworm-slim

WORKDIR /workspace

RUN apt-get update \
  && apt-get install --no-install-recommends --yes postgresql-client \
  && rm -rf /var/lib/apt/lists/*

# Photo and import stores share this image-owned private parent.
RUN install -d -m 0700 /var/lib/laundry

COPY --from=build /workspace /workspace

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["node", "apps/server/dist/http/main.js"]
