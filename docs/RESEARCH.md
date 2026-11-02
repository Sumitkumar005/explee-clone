# Explee teardown and feature parity

Research date: 2 November 2026.

## How the research was done

1. **REA (morluto/rea), from `rea-main.zip`.** Unzipped and reviewed. REA is an MCP server for reverse-engineering binaries, Electron apps, .NET assemblies and websites. Its website mode drives Chrome over the DevTools Protocol (`src/browser/Cdp*`) to capture network traffic, scripts and storage. That is the right tool for a site you're allowed to inspect. The archive is kept in the repo as uploaded. Its contents aren't vendored into the app.
2. **Direct capture of explee.com didn't work.** Every request to `explee.com` and `explee.com/pricing` gets a Cloudflare managed challenge (HTTP 403, "Just a moment..."). Getting past a bot check is circumvention, so I didn't try. With REA or Playwright you only get the challenge page, so there were no bundles, API calls or DB schema to capture.
3. **Public sources.** The product spec below comes from third-party reviews and directories. Some of them sell competing products, so treat their numbers carefully:
   - [ColdIQ: Explee review](https://coldiq.com/tools/explee)
   - [Salesforge: Explee review](https://www.salesforge.ai/blog/explee-review) (hands-on AutoGTM test, competitor)
   - [AI Directories: Explee review](https://www.aidirectori.es/blog/explee-review)
   - [Readray/Lilys: video summary](https://lilys.ai/it/notes/ai-lead-generation-20251030/explee-review-ai-lead-generation)
   - [There's An AI For That](https://theresanaiforthat.com/ai/explee/), [Futurepedia](https://www.futurepedia.io/tool/explee), [G2 pricing](https://g2.com/products/explee/pricing)

**To get a 1:1 UI and API match:** log into your own Explee account in a normal browser and run REA (`npx rea-agents setup`, then point its browser capture at your logged-in session). Then send me the HAR or REA evidence bundle. Field names, endpoints and copy can be aligned from that.

## What Explee is (from sources)

Two products on one data layer:

| Product | What it does |
|---|---|
| **AI Search** | Plain-English search over a B2B database. Sources cite 40M to 105M companies and 536M profiles. Ranked results with match highlighting, an "AI enrichment" panel that scores each company against a custom question, a "prompt filter", lookalike companies, decision-maker contacts with verified emails (bounce rate under 3% claimed), contact dedup, export. You can search free without signing up. |
| **AutoGTM** | Autonomous outbound. Learns your product from your website, proposes buyer groups with a fit score (for example event designers 92%, wedding floral studios 88%), finds prospects in them, writes a personal email for each, sends from a pool of pre-warmed inboxes (not your domain), handles replies and books meetings. Audience status shows as Scaling, Working or Paused, with cost per lead. |

Pricing reported (conflicting, unverified): free search; first 200 to 333 emails free; $50 per 1,000 verified emails (June 2025); a later monthly ladder of Free / $49 / $329 / $490; AutoGTM pay-as-you-go at $10 to $100, about $0.03 per email, estimated $1 to $15 per lead.

User complaints worth designing against (Trustpilot via Salesforge): sending started on its own after leads went 2 hours without approval; sender names and domains couldn't be changed; replies were misclassified as "hot"; billing and cancellation problems.

## Feature parity in this build

| Explee feature | Status here | Where |
|---|---|---|
| Natural-language company search | Done. Claude parses the query into structured filters, with a regex fallback offline | `server/ai.js` `parseQuery` |
| Search without sign-up | Done. Page 1 is open to anyone; sign-up unlocks the rest | `server/index.js` `ANON_PAGE_LIMIT` |
| Fit score and highlighted matches | Done | `server/search.js` `score` |
| Editable structured filters | Done: industry, country, size, funding stage, recently funded, model, work policy, tech, keywords | `public/app.js` `filterSidebar` |
| AI enrichment column (yes/no/unsure plus reason per row) | Done. Plan-limited (1/3/5/10 per search); cells fill for new pages; removable | `/api/searches/:id/criteria` |
| Prompt filter | Done. AI checks the top N and keeps the yes rows | `/api/searches/:id/prompt-filter` |
| Lookalike companies | Done. Known domain uses industry, tags, tech, size and geo similarity; unknown domain gets profiled from its website first | `/api/search/lookalike` |
| People / decision-maker search | Done: title, seniority, department, industry, country, verified-only | `/api/people/search` |
| Masked contacts, pay to reveal | Done. 1 credit; charged once per contact per user | `/api/people/reveal` |
| Email verification status | Done (verified / risky / unknown) | `people.email_status` |
| Contact dedup | Done. Reveals are unique per user and contact; AutoGTM takes one contact per company and never re-adds a person | `reveals` PK, `gtm.activateSegment` |
| Lists and CSV export | Done. AI columns export as extra CSV columns | `/api/lists*`, `/api/export/*` |
| Search history | Done | `/api/searches` |
| Credits, plans, top-ups, ledger | Done (test-mode checkout) | `server/credits.js` |
| AutoGTM: website analysis, segments with fit % | Done | `gtm.createCampaign` |
| AutoGTM: prospecting and personal emails | Done | `gtm.activateSegment`, `ai.writeEmail` |
| AutoGTM: pre-warmed separate inboxes | Simulated. 3 inboxes per campaign on separate domains with a daily cap | `gtm_inboxes` |
| AutoGTM: sending | Simulated transport. Swap in SMTP, SES or Gmail | `gtm.transport` |
| AutoGTM: follow-ups | Done. Step 2 is drafted for non-repliers | `gtm.tick` |
| AutoGTM: reply classification (hot/warm/not interested/OOO/unsubscribe) | Done | `ai.classifyReply` |
| AutoGTM: auto-drafted meeting reply, meeting booked | Done | `gtm.simulateReplies`, `/meeting` |
| AutoGTM: Scaling / Working / Paused segments, cost per lead | Done. Auto-scales at 5% or more lead rate | `gtm.autoTuneSegments` |
| AutoGTM: budget slider ($10 to $100, about 333 emails per $10) | Done. The campaign pauses at its budget | `newCampaign`, `gtm.tick` |

## Deliberate improvements over the complaints

- **Human approval is the default.** Nothing sends, including follow-ups and replies, until you approve it. There's no silent auto-send timer. Auto-approve is an explicit opt-in.
- **Sender name, title, language and meeting link are editable** per campaign.
- **Hard budget cap**, and the campaign pauses when credits run out.
- Every credit movement goes in a ledger the user can see.

## What isn't real yet (be clear about this before any demo)

1. **Data.** The 6,000 companies and about 24,000 people are synthetic. Every domain ends in `.example`, so none of it can be mistaken for real contact data. A production build needs a licensed B2B data provider (People Data Labs, Apollo, Coresignal, Crunchbase and so on) and an email verifier. Don't scrape LinkedIn: it breaks their terms of service and creates GDPR exposure.
2. **Sending and replies are simulated.** In demo mode about 20% of prospects "reply" with canned text. Turn this off with `GTM_SIMULATE_REPLIES=false` once a real transport and inbox polling are wired.
3. **Cold-email compliance isn't built.** That means no unsubscribe footer or suppression list, no physical address line, and no per-country rules (GDPR legitimate-interest assessment for EU/UK, CAN-SPAM, India's DPDP Act). This has to exist before any real send.
4. **Payments are in test mode.** Stripe Checkout and webhooks need wiring.
