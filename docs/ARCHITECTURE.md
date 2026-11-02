# Architecture

```
public/            Vanilla JS single-page app (hash router), no build step
  index.html  app.js  styles.css
server/
  index.js         HTTP server, routing, auth (scrypt + HttpOnly session cookie), CSV export
  db.js            SQLite schema (node:sqlite, built into Node 22)
  seed.js          Deterministic synthetic dataset (6,000 companies, ~24,000 people)
  search.js        Filter-to-SQL, fit scoring, lookalike similarity, people search, masking
  ai.js            Claude calls (structured JSON outputs) + offline heuristic fallbacks
  credits.js       Wallet, ledger, plans, costs
  gtm.js           AutoGTM pipeline and background worker
test/api.test.js   End-to-end API tests (node:test), offline mode
```

Runtime dependency: `@anthropic-ai/sdk` only. Database: one SQLite file at `data/app.db`.

## Data model

| Table | Purpose |
|---|---|
| `companies` | Firmographics: industry, tags, tech, geo, size, revenue, funding, model, work policy, hiring |
| `people` | Decision makers: title, seniority, department, email + verification status, phone, LinkedIn |
| `users`, `sessions` | Accounts, credit balance, plan |
| `searches` | Saved searches: query, parsed filters, AI criteria list |
| `criteria_results` | AI column cells: search x company x criterion -> verdict + reason |
| `reveals` | Which contacts a user has paid to unmask (dedup) |
| `lists`, `list_items` | Saved companies / people |
| `credit_ledger` | Every credit grant and charge with running balance |
| `gtm_campaigns` | Product analysis, sender, language, budget, approval mode, status |
| `gtm_segments` | Buyer segments: fit score, search query, target titles, status |
| `gtm_inboxes` | Sending inboxes with warm-up score and daily counters |
| `gtm_prospects` | Person in a campaign: stage (pending_approval > approved > sent > replied > meeting), lead temperature |
| `gtm_messages` | Outbound drafts/sends and inbound replies with classification |

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/meta` | Filter vocab, plans, costs, AI status, dataset size |
| POST | `/api/auth/signup` `/login` `/logout`, GET `/api/me` | |
| POST | `/api/search/companies` | `{query}` or `{search_id, filters}`, `page`, `sort` |
| POST | `/api/search/lookalike` | `{domain}` |
| POST | `/api/searches/:id/criteria` | Add AI column `{criterion, company_ids}` |
| POST | `/api/searches/:id/criteria/fill` | Fill existing AI columns for new rows |
| DELETE | `/api/searches/:id/criteria/:idx` | Remove AI column |
| POST | `/api/searches/:id/prompt-filter` | `{prompt, limit}` |
| GET | `/api/searches` | History |
| GET | `/api/companies/:id` | Profile + masked contacts |
| POST | `/api/people/search`, `/api/people/reveal` | |
| * | `/api/lists`, `/api/lists/:id`, `/items`, `/export.csv` | |
| POST | `/api/export/companies`, `/api/export/people` | CSV |
| GET/POST | `/api/billing`, `/api/billing/checkout` | Test mode |
| * | `/api/gtm/campaigns[/:id]`, `/prospects`, `/approve-all` | |
| POST/PATCH | `/api/gtm/segments/:id/activate`, `/api/gtm/segments/:id` | |
| POST | `/api/gtm/prospects/:id/review` `/reply` `/meeting` | |

## AI

`server/ai.js` calls `claude-opus-5-5` (override with `CLAUDE_MODEL`) through the official SDK, using `output_config.format` JSON schemas, low effort for classification, and server-side refusal fallbacks. If a call fails, is refused, or no key is set, each function falls back to a deterministic heuristic so the product still works. AI criteria run in batches of 25 companies per call.

## Production swaps

| Area | Now | Swap to |
|---|---|---|
| Data | `seed.js` synthetic | Licensed provider ingest job into the same `companies` / `people` tables; nightly refresh; email verifier on reveal |
| Search at 100M rows | SQLite + in-process scoring | Postgres + pgvector or OpenSearch with embeddings of descriptions for semantic recall, then the same fit scoring |
| Sending | `gtm.transport` logs | SMTP / Amazon SES / Gmail API per inbox; warm-up service; SPF/DKIM/DMARC on sending domains |
| Replies | Simulated | IMAP / Gmail push per inbox -> `gtm_messages` (direction `in`) -> `classifyReply` |
| Compliance | Not built | Unsubscribe link + suppression table checked before every send; footer with address; region rules |
| Billing | Test-mode checkout | Stripe Checkout + webhook that calls `credits.grant` |
| Worker | `setInterval` in web process | Separate worker process or queue (BullMQ / SQS) |
