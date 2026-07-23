FROM node:22-bookworm-slim AS build

WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts --filter @laundry/server...

COPY apps/server apps/server
COPY packages/config/tsconfig packages/config/tsconfig
COPY packages/contracts packages/contracts
COPY packages/domain packages/domain
COPY packages/db/src/migrations packages/db/src/migrations

RUN pnpm --filter @laundry/server... build

COPY tools/compose tools/compose

FROM node:22-bookworm-slim

WORKDIR /workspace

RUN apt-get update \
  && apt-get install --no-install-recommends --yes postgresql-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /workspace /workspace

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["node", "apps/server/dist/http/main.js"]
