'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, tx } = require('./db');
const { seed, INDUSTRIES, GEO, STAGES, TECH } = require('./seed');
const ai = require('./ai');
const S = require('./search');
const credits = require('./credits');
const gtm = require('./gtm');

const PORT = +(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const ANON_PAGE_LIMIT = 1;

// ---------------------------------------------------------------- helpers
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const send = (res, status, body, headers = {}) => {
  const isStr = typeof body === 'string';
  res.writeHead(status, { 'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
};
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) throw new HttpError(413, 'Body too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
const checkPw = (pw, stored) => { const [salt, h] = stored.split(':'); const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
function currentUser(req) {
  const t = cookies(req).sid;
  if (!t) return null;
  return db.prepare('SELECT u.id, u.email, u.name, u.credits, u.plan, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(t) || null;
}
const needUser = (u) => { if (!u) throw new HttpError(401, 'Sign in to do this'); return u; };
function newSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  res.setHeader('set-cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
}
const csvEscape = (v) => { const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n');
const COMPANY_COLS = ['name', 'domain', 'industry', 'description', 'tags', 'technologies', 'city', 'country', 'employees', 'revenue_usd', 'funding_stage', 'funding_total_usd', 'last_funding_date', 'founded_year', 'business_model', 'remote_policy', 'hiring_open_roles', 'linkedin_url'];
const PEOPLE_COLS = ['first_name', 'last_name', 'title', 'seniority', 'department', 'email', 'email_status', 'phone', 'linkedin_url', 'city', 'country', 'company_name', 'company_domain'];
const getCompanies = (ids) => ids.length ? db.prepare(`SELECT * FROM companies WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(S.hydrate) : [];

function attachCriteria(searchId, rows) {
  if (!searchId || !rows.length) return rows;
  const res = db.prepare(`SELECT * FROM criteria_results WHERE search_id = ? AND company_id IN (${rows.map(() => '?').join(',')})`).all(searchId, ...rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, criteria: Object.fromEntries(res.filter((x) => x.company_id === r.id).map((x) => [x.criterion_idx, { verdict: x.verdict, reason: x.reason }])) }));
}

async function runCriteria(user, searchId, companies, criteria, startIdx, reason) {
  const cost = companies.length * criteria.length * credits.COSTS.ai_criterion_row;
  credits.charge(user.id, cost, reason, `search:${searchId}`);
  const results = await ai.evaluateCriteria(companies, criteria);
  const ins = db.prepare('INSERT OR REPLACE INTO criteria_results (search_id, company_id, criterion_idx, verdict, reason) VALUES (?,?,?,?,?)');
  tx(() => { for (const c of companies) criteria.forEach((_, i) => { const r = results.get(`${c.id}:${i}`); ins.run(searchId, c.id, startIdx + i, r.verdict, r.reason); }); });
  return cost;
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

route('GET', '/api/meta', () => ({ industries: Object.keys(INDUSTRIES), countries: Object.keys(GEO), stages: STAGES, technologies: TECH,
  seniorities: ['Founder', 'C-Level', 'VP', 'Head', 'Director', 'Manager', 'IC'], departments: ['Executive', 'Sales', 'Marketing', 'Engineering', 'Operations', 'Finance', 'HR', 'Design', 'Business Development'],
  plans: credits.PLANS, topups: credits.TOPUPS, costs: credits.COSTS, ai: { enabled: ai.aiEnabled(), model: ai.aiEnabled() ? ai.MODEL : null },
  stats: { companies: db.prepare('SELECT COUNT(*) n FROM companies').get().n, people: db.prepare('SELECT COUNT(*) n FROM people').get().n } }));

// auth
route('POST', '/api/auth/signup', async ({ req, res }) => {
  const { email, password, name } = await readBody(req);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new HttpError(400, 'Enter a valid email');
  if (!password || password.length < 8) throw new HttpError(400, 'Password needs at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) throw new HttpError(409, 'An account with this email exists. Sign in instead.');
  const r = db.prepare('INSERT INTO users (email, name, password_hash, credits) VALUES (?,?,?,0)').run(email.toLowerCase(), name || email.split('@')[0], hashPw(password));
  credits.grant(r.lastInsertRowid, credits.FREE_SIGNUP_CREDITS, 'signup_bonus');
  newSession(res, r.lastInsertRowid);
  return { ok: true };
});
route('POST', '/api/auth/login', async ({ req, res }) => {
  const { email, password } = await readBody(req);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!u || !checkPw(password || '', u.password_hash)) throw new HttpError(401, 'Wrong email or password');
  newSession(res, u.id);
  return { ok: true };
});
route('POST', '/api/auth/logout', ({ req, res }) => { db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies(req).sid || ''); res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0'); return { ok: true }; });
route('GET', '/api/me', ({ user }) => ({ user: user ? { ...user, plan_info: credits.planFor(user) } : null }));

// company search
route('POST', '/api/search/companies', async ({ req, user }) => {
  const b = await readBody(req);
  const page = Math.max(1, +b.page || 1);
  if (!user && page > ANON_PAGE_LIMIT) throw new HttpError(401, 'Sign up free to see more than the first page of results');
  let searchId = b.search_id && user ? db.prepare('SELECT id FROM searches WHERE id = ? AND user_id = ?').get(b.search_id, user.id)?.id : null;
  let filters = b.filters, criteria = [];
  if (searchId) { const s = db.prepare('SELECT * FROM searches WHERE id = ?').get(searchId); filters = b.filters || JSON.parse(s.filters); criteria = JSON.parse(s.criteria || '[]'); }
  if (!filters) { if (!b.query?.trim()) throw new HttpError(400, 'Describe the companies you want'); filters = await ai.parseQuery(b.query.trim()); }
  const out = S.searchCompanies(filters, { page, pageSize: Math.min(100, +b.page_size || 25), sort: b.sort });
  if (user && !searchId) {
    searchId = db.prepare('INSERT INTO searches (user_id, kind, query, filters, criteria, result_count) VALUES (?,?,?,?,?,?)').run(user.id, 'companies', b.query || '', JSON.stringify(filters), '[]', out.total).lastInsertRowid;
  } else if (searchId && b.filters) db.prepare('UPDATE searches SET filters = ?, result_count = ? WHERE id = ?').run(JSON.stringify(filters), out.total, searchId);
  return { search_id: searchId, filters, criteria, total: out.total, page, page_size: out.pageSize, results: attachCriteria(searchId, out.results) };
});

route('POST', '/api/search/lookalike', async ({ req, user }) => {
  const b = await readBody(req);
  const domain = String(b.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new HttpError(400, 'Enter a company domain, e.g. stripe.com');
  let seedCo = S.hydrate(db.prepare('SELECT * FROM companies WHERE domain = ?').get(domain));
  if (!seedCo) { // unknown company: profile it from its website, then match on the inferred profile
    const a = await ai.analyzeWebsite(`https://${domain}`);
    const f = await ai.parseQuery(`${a.product_summary}`);
    seedCo = { id: null, name: domain, domain, industry: f.industries[0] || null, tags: f.keywords, technologies: f.technologies, employees: 50, country: f.countries[0], business_model: f.business_model, description: a.product_summary };
  }
  const page = Math.max(1, +b.page || 1);
  if (!user && page > ANON_PAGE_LIMIT) throw new HttpError(401, 'Sign up free to see more results');
  const out = S.lookalike(seedCo, { page, countries: b.countries || [] });
  let searchId = null;
  if (user && page === 1) searchId = db.prepare('INSERT INTO searches (user_id, kind, query, filters, criteria, result_count) VALUES (?,?,?,?,?,?)').run(user.id, 'lookalike', domain, JSON.stringify({ lookalike: domain }), '[]', out.total).lastInsertRowid;
  return { search_id: searchId || b.search_id || null, seed: seedCo, total: out.total, page, page_size: out.pageSize, results: out.results };
});

// AI criteria column: evaluates the visible page (or given ids) for the new criterion.
route('POST', '/api/searches/:id/criteria', async ({ req, user, params }) => {
  needUser(user);
  const s = db.prepare('SELECT * FROM searches WHERE id = ? AND user_id = ?').get(params.id, user.id);
  if (!s) throw new HttpError(404, 'Search not found');
  const b = await readBody(req);
  const crit = String(b.criterion || '').trim();
  if (!crit) throw new HttpError(400, 'Write a yes/no question, e.g. "Do they sell on a subscription?"');
  const criteria = JSON.parse(s.criteria || '[]');
  const plan = credits.planFor(user);
  if (criteria.length >= plan.ai_criteria_per_search) throw new HttpError(402, `${plan.name} plan allows ${plan.ai_criteria_per_search} AI criteria per search. Upgrade for more.`);
  const ids = (b.company_ids || []).slice(0, 100);
  const companies = getCompanies(ids);
  if (!companies.length) throw new HttpError(400, 'No companies to evaluate');
  const cost = await runCriteria(user, s.id, companies, [crit], criteria.length, 'ai_criterion');
  criteria.push(crit);
  db.prepare('UPDATE searches SET criteria = ? WHERE id = ?').run(JSON.stringify(criteria), s.id);
  return { criteria, charged: cost, results: attachCriteria(s.id, companies).map((c) => ({ id: c.id, criteria: c.criteria })) };
});
// Re-run existing criteria on newly visible rows (e.g. page 2).
route('POST', '/api/searches/:id/criteria/fill', async ({ req, user, params }) => {
  needUser(user);
  const s = db.prepare('SELECT * FROM searches WHERE id = ? AND user_id = ?').get(params.id, user.id);
  if (!s) throw new HttpError(404, 'Search not found');
  const criteria = JSON.parse(s.criteria || '[]');
  const { company_ids = [] } = await readBody(req);
  const done = new Set(db.prepare('SELECT DISTINCT company_id FROM criteria_results WHERE search_id = ?').all(s.id).map((r) => r.company_id));
  const todo = getCompanies(company_ids.filter((id) => !done.has(id)).slice(0, 100));
  const cost = criteria.length && todo.length ? await runCriteria(user, s.id, todo, criteria, 0, 'ai_criterion') : 0;
  return { charged: cost, results: attachCriteria(s.id, getCompanies(company_ids)).map((c) => ({ id: c.id, criteria: c.criteria })) };
});
route('DELETE', '/api/searches/:id/criteria/:idx', ({ user, params }) => {
  needUser(user);
  const s = db.prepare('SELECT * FROM searches WHERE id = ? AND user_id = ?').get(params.id, user.id);
  if (!s) throw new HttpError(404, 'Search not found');
  const criteria = JSON.parse(s.criteria || '[]'); const idx = +params.idx;
  criteria.splice(idx, 1);
  tx(() => {
    db.prepare('DELETE FROM criteria_results WHERE search_id = ? AND criterion_idx = ?').run(s.id, idx);
    db.prepare('UPDATE criteria_results SET criterion_idx = criterion_idx - 1 WHERE search_id = ? AND criterion_idx > ?').run(s.id, idx);
    db.prepare('UPDATE searches SET criteria = ? WHERE id = ?').run(JSON.stringify(criteria), s.id);
  });
  return { criteria };
});

// Prompt filter: AI checks top N matches and keeps only the "yes" ones.
route('POST', '/api/searches/:id/prompt-filter', async ({ req, user, params }) => {
  needUser(user);
  const s = db.prepare('SELECT * FROM searches WHERE id = ? AND user_id = ?').get(params.id, user.id);
  if (!s) throw new HttpError(404, 'Search not found');
  const { prompt, limit = 50 } = await readBody(req);
  if (!prompt?.trim()) throw new HttpError(400, 'Describe what to keep');
  const { results } = S.searchCompanies(JSON.parse(s.filters), { pageSize: Math.min(200, +limit) });
  credits.charge(user.id, results.length * credits.COSTS.prompt_filter_row, 'prompt_filter', `search:${s.id}`);
  const verdicts = await ai.evaluateCriteria(results, [prompt.trim()]);
  const kept = results.filter((c) => verdicts.get(`${c.id}:0`).verdict === 'yes').map((c) => ({ ...c, filter_reason: verdicts.get(`${c.id}:0`).reason }));
  return { checked: results.length, kept: kept.length, charged: results.length, results: attachCriteria(s.id, kept) };
});

route('GET', '/api/searches', ({ user }) => needUser(user) && db.prepare('SELECT * FROM searches WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(user.id).map((s) => ({ ...s, filters: JSON.parse(s.filters || '{}'), criteria: JSON.parse(s.criteria || '[]') })));

// companies & people
route('GET', '/api/companies/:id', ({ user, params }) => {
  const c = S.hydrate(db.prepare('SELECT * FROM companies WHERE id = ?').get(params.id));
  if (!c) throw new HttpError(404, 'Company not found');
  return { company: c, people: S.searchPeople({ company_ids: [c.id] }, { userId: user?.id, pageSize: 50 }).results };
});
route('POST', '/api/people/search', async ({ req, user }) => {
  const b = await readBody(req);
  const page = Math.max(1, +b.page || 1);
  if (!user && page > ANON_PAGE_LIMIT) throw new HttpError(401, 'Sign up free to see more results');
  return S.searchPeople(b.filters || {}, { userId: user?.id, page, pageSize: Math.min(100, +b.page_size || 25) });
});
route('POST', '/api/people/reveal', async ({ req, user }) => {
  needUser(user);
  const { ids = [] } = await readBody(req);
  const want = [...new Set(ids.map(Number))].slice(0, 500);
  if (!want.length) throw new HttpError(400, 'Pick contacts to reveal');
  const have = new Set(db.prepare(`SELECT person_id FROM reveals WHERE user_id = ? AND person_id IN (${want.map(() => '?').join(',')})`).all(user.id, ...want).map((r) => r.person_id));
  const fresh = want.filter((id) => !have.has(id));
  tx(() => {
    credits.charge(user.id, fresh.length * credits.COSTS.reveal_email, 'reveal_email', `${fresh.length} contacts`, { inTx: true });
    const ins = db.prepare('INSERT OR IGNORE INTO reveals (user_id, person_id) VALUES (?, ?)');
    fresh.forEach((id) => ins.run(user.id, id));
  });
  const rows = db.prepare(`SELECT p.*, c.name company_name, c.domain company_domain, 1 revealed FROM people p JOIN companies c ON c.id = p.company_id WHERE p.id IN (${want.map(() => '?').join(',')})`).all(...want);
  return { charged: fresh.length, balance: credits.balance(user.id), results: rows.map(S.publicPerson) };
});

// lists
const ownList = (user, id) => { const l = db.prepare('SELECT * FROM lists WHERE id = ? AND user_id = ?').get(id, user.id); if (!l) throw new HttpError(404, 'List not found'); return l; };
route('GET', '/api/lists', ({ user }) => needUser(user) && db.prepare('SELECT l.*, (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) items FROM lists l WHERE user_id = ? ORDER BY id DESC').all(user.id));
route('POST', '/api/lists', async ({ req, user }) => {
  needUser(user);
  const { name, kind = 'companies' } = await readBody(req);
  if (!name?.trim() || !['companies', 'people'].includes(kind)) throw new HttpError(400, 'Name the list and pick companies or people');
  return db.prepare('SELECT * FROM lists WHERE id = ?').get(db.prepare('INSERT INTO lists (user_id, name, kind) VALUES (?,?,?)').run(user.id, name.trim(), kind).lastInsertRowid);
});
route('GET', '/api/lists/:id', ({ user, params }) => {
  const l = ownList(needUser(user), params.id);
  const ids = db.prepare('SELECT entity_id FROM list_items WHERE list_id = ? ORDER BY added_at DESC').all(l.id).map((r) => r.entity_id);
  const items = l.kind === 'companies' ? getCompanies(ids) : ids.length ? db.prepare(`SELECT p.*, c.name company_name, c.domain company_domain, (SELECT 1 FROM reveals r WHERE r.user_id = ? AND r.person_id = p.id) revealed FROM people p JOIN companies c ON c.id = p.company_id WHERE p.id IN (${ids.map(() => '?').join(',')})`).all(user.id, ...ids).map(S.publicPerson) : [];
  return { ...l, items };
});
route('POST', '/api/lists/:id/items', async ({ req, user, params }) => {
  const l = ownList(needUser(user), params.id);
  const { ids = [] } = await readBody(req);
  const ins = db.prepare('INSERT OR IGNORE INTO list_items (list_id, entity_id) VALUES (?, ?)');
  let added = 0; tx(() => ids.forEach((id) => { added += ins.run(l.id, +id).changes; }));
  return { added };
});
route('DELETE', '/api/lists/:id/items/:eid', ({ user, params }) => { const l = ownList(needUser(user), params.id); db.prepare('DELETE FROM list_items WHERE list_id = ? AND entity_id = ?').run(l.id, +params.eid); return { ok: true }; });
route('DELETE', '/api/lists/:id', ({ user, params }) => { const l = ownList(needUser(user), params.id); db.prepare('DELETE FROM lists WHERE id = ?').run(l.id); return { ok: true }; });
route('GET', '/api/lists/:id/export.csv', ({ user, params, res }) => {
  const l = ownList(needUser(user), params.id);
  const ids = db.prepare('SELECT entity_id FROM list_items WHERE list_id = ?').all(l.id).map((r) => r.entity_id);
  let csv;
  if (l.kind === 'companies') csv = toCsv(getCompanies(ids), COMPANY_COLS);
  else csv = toCsv(ids.length ? db.prepare(`SELECT p.*, c.name company_name, c.domain company_domain, (SELECT 1 FROM reveals r WHERE r.user_id = ? AND r.person_id = p.id) revealed FROM people p JOIN companies c ON c.id = p.company_id WHERE p.id IN (${ids.map(() => '?').join(',')})`).all(user.id, ...ids).map(S.publicPerson) : [], PEOPLE_COLS);
  send(res, 200, csv, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${l.name.replace(/[^\w-]+/g, '_')}.csv"` });
});
route('POST', '/api/export/companies', async ({ req, user, res }) => {
  needUser(user);
  const { ids = [], search_id } = await readBody(req);
  let rows = getCompanies(ids.slice(0, 5000).map(Number));
  if (search_id) {
    const s = db.prepare('SELECT * FROM searches WHERE id = ? AND user_id = ?').get(search_id, user.id);
    const crit = JSON.parse(s?.criteria || '[]');
    rows = attachCriteria(s?.id, rows).map((r) => ({ ...r, ...Object.fromEntries(crit.map((c, i) => [`AI: ${c}`, r.criteria?.[i] ? `${r.criteria[i].verdict} - ${r.criteria[i].reason}` : ''])) }));
    send(res, 200, toCsv(rows, [...COMPANY_COLS, ...crit.map((c) => `AI: ${c}`)]), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="companies.csv"' });
    return;
  }
  send(res, 200, toCsv(rows, COMPANY_COLS), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="companies.csv"' });
});
route('POST', '/api/export/people', async ({ req, user, res }) => {
  needUser(user);
  const { ids = [] } = await readBody(req);
  const want = ids.slice(0, 5000).map(Number);
  const rows = want.length ? db.prepare(`SELECT p.*, c.name company_name, c.domain company_domain, (SELECT 1 FROM reveals r WHERE r.user_id = ? AND r.person_id = p.id) revealed FROM people p JOIN companies c ON c.id = p.company_id WHERE p.id IN (${want.map(() => '?').join(',')})`).all(user.id, ...want).map(S.publicPerson) : [];
  send(res, 200, toCsv(rows, PEOPLE_COLS), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="contacts.csv"' });
});

// billing (test mode: checkout applies immediately; wire Stripe Checkout in production)
route('GET', '/api/billing', ({ user }) => ({ balance: needUser(user).credits, plan: credits.planFor(user), plans: credits.PLANS, topups: credits.TOPUPS, costs: credits.COSTS,
  ledger: db.prepare('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id), test_mode: !process.env.STRIPE_SECRET_KEY }));
route('POST', '/api/billing/checkout', async ({ req, user }) => {
  needUser(user);
  const { plan, topup } = await readBody(req);
  if (process.env.STRIPE_SECRET_KEY) throw new HttpError(501, 'Stripe checkout not wired yet: see docs/ARCHITECTURE.md');
  if (plan) {
    const p = credits.PLANS.find((x) => x.id === plan);
    if (!p) throw new HttpError(400, 'Unknown plan');
    db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(p.id, user.id);
    if (p.monthly_credits && p.id !== 'free') credits.grant(user.id, p.monthly_credits, `plan_${p.id}_monthly`);
    return { ok: true, balance: credits.balance(user.id), plan: p.id };
  }
  const t = credits.TOPUPS.find((x) => x.id === topup);
  if (!t) throw new HttpError(400, 'Unknown top-up');
  return { ok: true, balance: credits.grant(user.id, t.credits, t.id) };
});

// AutoGTM
route('GET', '/api/gtm/campaigns', ({ user }) => needUser(user) && db.prepare('SELECT id FROM gtm_campaigns WHERE user_id = ? ORDER BY id DESC').all(user.id).map((r) => gtm.getCampaign(user.id, r.id)));
route('POST', '/api/gtm/campaigns', async ({ req, user }) => gtm.createCampaign(needUser(user).id, await readBody(req)));
route('GET', '/api/gtm/campaigns/:id', ({ user, params }) => { const c = gtm.getCampaign(needUser(user).id, +params.id); if (!c) throw new HttpError(404, 'Campaign not found'); return c; });
route('PATCH', '/api/gtm/campaigns/:id', async ({ req, user, params }) => {
  const c = gtm.getCampaign(needUser(user).id, +params.id);
  if (!c) throw new HttpError(404, 'Campaign not found');
  const b = await readBody(req);
  const fields = { status: ['draft', 'running', 'paused'], auto_approve: null, daily_limit: null, budget_usd: null, sender_name: null, sender_title: null, meeting_link: null, language: null };
  for (const [k, allowed] of Object.entries(fields)) {
    if (b[k] === undefined) continue;
    if (allowed && !allowed.includes(b[k])) throw new HttpError(400, `Bad ${k}`);
    if (k === 'status' && b[k] === 'running' && !c.segments.some((s) => ['working', 'scaling'].includes(s.status))) throw new HttpError(400, 'Activate at least one segment first');
    db.prepare(`UPDATE gtm_campaigns SET ${k} = ? WHERE id = ?`).run(k === 'auto_approve' ? (b[k] ? 1 : 0) : b[k], c.id);
  }
  return gtm.getCampaign(user.id, c.id);
});
route('POST', '/api/gtm/segments/:id/activate', async ({ user, params }) => gtm.activateSegment(needUser(user).id, +params.id));
route('PATCH', '/api/gtm/segments/:id', async ({ req, user, params }) => {
  needUser(user);
  const { status } = await readBody(req);
  if (!['working', 'paused'].includes(status)) throw new HttpError(400, 'Status must be working or paused');
  const r = db.prepare('UPDATE gtm_segments SET status = ? WHERE id = ? AND campaign_id IN (SELECT id FROM gtm_campaigns WHERE user_id = ?)').run(status, +params.id, user.id);
  if (!r.changes) throw new HttpError(404, 'Segment not found');
  return { ok: true };
});
route('GET', '/api/gtm/campaigns/:id/prospects', ({ user, params, url }) => { const r = gtm.listProspects(needUser(user).id, +params.id, { stage: url.searchParams.get('stage') || undefined }); if (!r) throw new HttpError(404, 'Campaign not found'); return r; });
route('POST', '/api/gtm/campaigns/:id/approve-all', ({ user, params }) => {
  const list = gtm.listProspects(needUser(user).id, +params.id, { stage: 'pending_approval' });
  if (!list) throw new HttpError(404, 'Campaign not found');
  list.forEach((p) => gtm.reviewProspect(user.id, p.id, { action: 'approve' }));
  return { approved: list.length };
});
route('POST', '/api/gtm/prospects/:id/review', async ({ req, user, params }) => gtm.reviewProspect(needUser(user).id, +params.id, await readBody(req)));
route('POST', '/api/gtm/prospects/:id/reply', async ({ req, user, params }) => gtm.reply(needUser(user).id, +params.id, await readBody(req)));
route('POST', '/api/gtm/prospects/:id/meeting', ({ user, params }) => gtm.setMeeting(needUser(user).id, +params.id));
route('POST', '/api/gtm/tick', async ({ user }) => { needUser(user); await gtm.tick(); return { ok: true }; });

// ---------------------------------------------------------------- server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html'); // SPA fallback
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    // CSRF guard for cookie-auth writes: browser requests must come from our own origin.
    if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-origin request blocked' });
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      try {
        const out = await r.handler({ req, res, url, params: m.groups || {}, user: currentUser(req) });
        if (!res.headersSent && out !== undefined) send(res, 200, out);
      } catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error(e);
        if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Something went wrong' : e.message, ...(e.needed ? { needed: e.needed, balance: e.balance } : {}) });
      }
      return;
    }
    send(res, 404, { error: 'Not found' });
  });
}

if (require.main === module) {
  const r = seed();
  console.log(r.skipped ? `Database ready: ${r.companies} companies` : `Seeded ${r.companies} companies`);
  gtm.startWorker();
  createServer().listen(PORT, () => console.log(`Leadscope running on http://localhost:${PORT}  (AI: ${ai.aiEnabled() ? ai.MODEL : 'offline heuristics'})`));
}

module.exports = { createServer };
