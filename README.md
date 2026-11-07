# Poster POS MCP server

A remote **Model Context Protocol** server that lets an AI assistant (Claude, from desktop or phone) **read and safely configure Poster POS accounts** across a multi-location restaurant/café network.

I built it to run my own 10-location coffee brand from a chat window: check menus, recipes, ingredients, purchases, balances and staff, and make controlled changes, without opening each POS back office.

## Why it's interesting

Letting an LLM write to a production POS is risky. The server enforces the safety rules itself, so they don't depend on the model behaving:

| Rule | How it's enforced |
|---|---|
| Account allow-list | Only accounts in `CUENTAS` (`src/config.ts`) can be touched, including for reads |
| Writes default to one account | `WRITE_DEFAULT_ACCOUNTS`. Any other account needs an explicit `permitir_otra_cuenta: true` on that call |
| **Dry-run by default** | Every write with `confirm: false` returns the diff, warnings and the exact payload without touching Poster |
| Apply once, then verify | `confirm: true` writes once (no retries, to avoid duplicates) and **reads back** to verify |
| Audit log | Every dry-run, apply and rejection is logged with who, when, account, method, payload (token-redacted) and result |
| Secrets never exposed | Tokens come from Google Secret Manager, are redacted from errors and logs, and no tool returns them |
| No destructive deletes | Items off the menu are **hidden**, not deleted |

## Tools

- **Read:** accounts, menu snapshot, product detail, ingredients, prepared items, customer groups, promotions, employees, payment methods, settings, purchases, balances, base catalogs, generic `get*` passthrough, recent audit.
- **Write (dry-run first):** customer groups, ingredients, purchases, dish and category updates, recipes, prepared items, categories, transactions, purchase payments, hide dish.

## Stack

TypeScript · Hono · MCP Streamable HTTP (stateless) · OAuth + bearer auth · Google Cloud Run · Secret Manager · Vitest (58 tests)

## Run locally

```bash
npm install
cp .env.example .env   # PORT, TOKEN_SOURCE, MCP_BEARER_TOKEN, ...
npm run dev
npx vitest run
```

Deployment notes (in Spanish): [DEPLOY_CLOUD_RUN.md](DEPLOY_CLOUD_RUN.md). Original Spanish README: [README.es.md](README.es.md).

## License

MIT © 2026 Roy Camacho Jácome. See [LICENSE](LICENSE).
