---
name: deepcrawl-dev
description: Develop, verify, and deploy the deepcrawl worker in this repo. Use when changing worker/ or packages/*, adding or editing an API endpoint or contract, regenerating the OpenAPI spec, running typecheck, lint, or migrations, or deploying to Cloudflare.
---

# Deepcrawl dev

Commands live in `package.json` scripts. This file holds what they don't say.

## Layout

- `worker/src/routers/<area>/`: oRPC handlers. `routers/index.ts` is the route table.
- `packages/contracts/src/`: one oRPC contract per endpoint. Handlers implement contracts.
- `packages/types`: zod schemas shared by contracts and handlers.
- `worker/src/mcp/`: MCP server mounted at `/mcp` in `app.ts`. One file per area in `tools/`, shared result and error helpers in `format.ts`. Tools call the oRPC router in-process, so a new endpoint is exposed over MCP by adding a `deepcrawl_<verb>_<noun>` tool with a title, a description (args, returns, errors) and annotations.
- `worker/openapi_orpc.yaml`: generated. Regenerate with `pnpm -C worker gen:openapi`; hand edits are overwritten.

## Add or change an endpoint

1. Edit the schema in `packages/types`, then the contract in `packages/contracts/src`.
2. Implement the handler in `worker/src/routers/<area>/`, then register it in `routers/index.ts`.
3. `pnpm -C worker gen:openapi`.
4. Done when `pnpm -C worker check` passes (typecheck plus `biome ci`) and the regenerated yaml diff shows the new route.

`pnpm -C worker fix` applies biome formatting.

## Deploy

Use the root scripts (`pnpm deploy`, `pnpm migrate`). `wrangler.jsonc` has no `env.production`, so the `deploy` script inside `worker/` fails against it.

- `pnpm build` is a dry-run bundle; run it before `pnpm deploy`.
- `AUTH_MODE=jwt`. `JWT_SECRET` is a Wrangler secret (`wrangler secret put JWT_SECRET` from `worker/`), never committed. `MCP_OAUTH_PASSWORD` (24+ characters) gates the MCP OAuth consent page and is set the same way; without it `/oauth/authorize` returns 503. `worker/.dev.vars.example` lists secret names only.
- `pnpm migrate` needs `CLOUDFLARE_API_TOKEN` and applies to the remote D1 `DB_V0`.

## Stale docs

`worker/README.md` came from upstream: its `env:bootstrap` step and `--env=production` flags do not apply here. The root `README.md` is current.
