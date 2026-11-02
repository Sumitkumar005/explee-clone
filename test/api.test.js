'use strict';
// End-to-end API tests. Runs against a temporary database with AI in offline-heuristic mode.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leadscope-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.GTM_SIMULATE_REPLIES = 'true';
process.env.GTM_REPLY_DELAY_MS = '0';
process.env.GTM_FOLLOWUP_AFTER_MS = '0';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const test = require('node:test');
const assert = require('node:assert/strict');
const { seed } = require('../server/seed');
const { createServer } = require('../server/index');
const gtm = require('../server/gtm');
const { db } = require('../server/db');

let base, server, cookie = '';
async function api(method, url, body, { raw = false, auth = true } = {}) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(auth && cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc && auth) cookie = sc.split(';')[0];
  return { status: res.status, body: raw ? await res.text() : await res.json() };
}

test.before(async () => {
  seed({ companies: 1500 });
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('anonymous natural-language search works without sign-up, page 2 needs an account', async () => {
  const r = await api('POST', '/api/search/companies', { query: 'fintech companies in the UK under 200 employees' }, { auth: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.filters.industries, ['Fintech']);
  assert.deepEqual(r.body.filters.countries, ['United Kingdom']);
  assert.equal(r.body.filters.employees_max, 200);
  assert.ok(r.body.results.every((c) => c.industry === 'Fintech' && c.country === 'United Kingdom' && c.employees <= 200));
  assert.ok(r.body.results.every((c) => c.fit_score > 0 && c.fit_score < 100));
  const p2 = await api('POST', '/api/search/companies', { query: 'fintech', page: 2 }, { auth: false });
  assert.equal(p2.status, 401);
});

test('sign-up grants 500 credits and logs it in the ledger', async () => {
  assert.equal((await api('POST', '/api/auth/signup', { email: 'founder@acme.io', password: 'longpassword', name: 'Founder' })).status, 200);
  const me = await api('GET', '/api/me');
  assert.equal(me.body.user.credits, 500);
  const bill = await api('GET', '/api/billing');
  assert.equal(bill.body.ledger[0].reason, 'signup_bonus');
  assert.equal((await api('POST', '/api/auth/signup', { email: 'founder@acme.io', password: 'longpassword' }, { auth: false })).status, 409);
});

let searchId, ids;
test('saved search, AI criteria column charges per row and respects plan limit', async () => {
  const r = await api('POST', '/api/search/companies', { query: 'TikTok growth agencies' });
  searchId = r.body.search_id; ids = r.body.results.slice(0, 5).map((c) => c.id);
  assert.ok(searchId);
  assert.ok(r.body.results[0].tags.join(' ').toLowerCase().includes('tiktok') || r.body.results[0].description.toLowerCase().includes('tiktok'));
  const c = await api('POST', `/api/searches/${searchId}/criteria`, { criterion: 'Do they focus on TikTok?', company_ids: ids });
  assert.equal(c.status, 200);
  assert.equal(c.body.charged, 5);
  assert.ok(c.body.results.every((x) => ['yes', 'no', 'unsure'].includes(x.criteria[0].verdict)));
  const again = await api('POST', `/api/searches/${searchId}/criteria`, { criterion: 'Second criterion?', company_ids: ids });
  assert.equal(again.status, 402, 'free plan allows 1 AI criterion');
  assert.equal((await api('GET', '/api/me')).body.user.credits, 495);
});

test('company profile masks contacts until revealed; reveal charges once', async () => {
  const prof = await api('GET', `/api/companies/${ids[0]}`);
  const person = prof.body.people[0];
  assert.match(person.email, /•/);
  const rv = await api('POST', '/api/people/reveal', { ids: [person.id] });
  assert.equal(rv.body.charged, 1);
  assert.doesNotMatch(rv.body.results[0].email, /•/);
  const rv2 = await api('POST', '/api/people/reveal', { ids: [person.id] });
  assert.equal(rv2.body.charged, 0);
});

test('people search filters by title and seniority', async () => {
  const r = await api('POST', '/api/people/search', { filters: { seniorities: ['VP'], titles: ['sales'] } });
  assert.ok(r.body.total > 0);
  assert.ok(r.body.results.every((p) => p.seniority === 'VP' && /sales/i.test(p.title)));
});

test('lookalike ranks same-industry companies first', async () => {
  const seedCo = db.prepare("SELECT domain, industry FROM companies WHERE industry = 'Cybersecurity' LIMIT 1").get();
  const r = await api('POST', '/api/search/lookalike', { domain: seedCo.domain });
  assert.equal(r.status, 200);
  assert.ok(r.body.results.slice(0, 10).every((c) => c.industry === 'Cybersecurity'));
  assert.equal((await api('POST', '/api/search/lookalike', { domain: 'notadomain' })).status, 400);
});

test('lists and CSV export', async () => {
  const l = await api('POST', '/api/lists', { name: 'UK fintech', kind: 'companies' });
  await api('POST', `/api/lists/${l.body.id}/items`, { ids });
  const got = await api('GET', `/api/lists/${l.body.id}`);
  assert.equal(got.body.items.length, ids.length);
  const csv = await api('GET', `/api/lists/${l.body.id}/export.csv`, null, { raw: true });
  assert.ok(csv.body.startsWith('name,domain,industry'));
  assert.equal(csv.body.trim().split('\n').length, ids.length + 1);
  const exp = await api('POST', '/api/export/companies', { ids, search_id: searchId }, { raw: true });
  assert.ok(exp.body.split('\n')[0].includes('AI: Do they focus on TikTok?'));
});

test('billing test mode: plan upgrade grants monthly credits', async () => {
  const r = await api('POST', '/api/billing/checkout', { plan: 'starter' });
  assert.equal(r.body.plan, 'starter');
  assert.ok(r.body.balance >= 5000);
});

test('AutoGTM: analyse, segments, approval gate, send, reply handling, metrics', async () => {
  const c = await api('POST', '/api/gtm/campaigns', { website: 'silkflowers.example', sender_name: 'Nikhil Jain', sender_title: 'Founder', budget_usd: 5 });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.ok(c.body.segments.length >= 3);
  assert.equal(c.body.inboxes.length, 3);
  assert.equal(c.body.auto_approve, false, 'human approval is the default');
  assert.equal((await api('PATCH', `/api/gtm/campaigns/${c.body.id}`, { status: 'running' })).status, 400, 'needs an active segment');

  const seg = c.body.segments[0];
  const act = await api('POST', `/api/gtm/segments/${seg.id}/activate`);
  assert.ok(act.body.added > 0, 'found prospects');
  const pending = await api('GET', `/api/gtm/campaigns/${c.body.id}/prospects?stage=pending_approval`);
  assert.equal(pending.body.length, act.body.added);
  assert.ok(pending.body[0].messages[0].body.includes(pending.body[0].first_name));

  await api('PATCH', `/api/gtm/campaigns/${c.body.id}`, { status: 'running' });
  await gtm.tick();
  let detail = await api('GET', `/api/gtm/campaigns/${c.body.id}`);
  assert.equal(detail.body.sent, 0, 'nothing sends before approval');

  // edit one draft, reject one, approve the rest
  const [first, second] = pending.body;
  await api('POST', `/api/gtm/prospects/${first.id}/review`, { subject: 'Edited subject', action: 'approve' });
  await api('POST', `/api/gtm/prospects/${second.id}/review`, { action: 'reject' });
  await api('POST', `/api/gtm/campaigns/${c.body.id}/approve-all`);
  const before = (await api('GET', '/api/me')).body.user.credits;
  await gtm.tick();
  detail = await api('GET', `/api/gtm/campaigns/${c.body.id}`);
  assert.equal(detail.body.sent, act.body.added - 1);
  assert.equal((await api('GET', '/api/me')).body.user.credits, before - 3 * detail.body.sent);
  const all = (await api('GET', `/api/gtm/campaigns/${c.body.id}/prospects`)).body;
  assert.equal(all.find((p) => p.id === first.id).messages[0].subject, 'Edited subject');
  assert.equal(all.find((p) => p.id === second.id).stage, 'rejected');
  assert.ok(all.filter((p) => p.lead_temp).length > 0, 'replies were processed');

  await gtm.tick(); // follow-ups drafted for non-repliers, held for approval
  const pend2 = (await api('GET', `/api/gtm/campaigns/${c.body.id}/prospects?stage=pending_approval`)).body;
  assert.ok(pend2.every((p) => p.messages.some((m) => m.step === 2 && m.status === 'draft')));

  const m = await api('POST', `/api/gtm/prospects/${first.id}/meeting`);
  assert.equal(m.body.stage, 'meeting');
  assert.equal((await api('PATCH', `/api/gtm/segments/${seg.id}`, { status: 'paused' })).status, 200);
});

test('budget cap pauses the campaign', async () => {
  const c = await api('POST', '/api/gtm/campaigns', { website: 'tinybudget.example', budget_usd: 0.03, auto_approve: true });
  await api('POST', `/api/gtm/segments/${c.body.segments[0].id}/activate`);
  await api('PATCH', `/api/gtm/campaigns/${c.body.id}`, { status: 'running' });
  await gtm.tick();
  const d = await api('GET', `/api/gtm/campaigns/${c.body.id}`);
  assert.equal(d.body.sent, 1);
  assert.equal(d.body.status, 'paused');
});

test('cross-user isolation', async () => {
  const mine = cookie;
  cookie = '';
  await api('POST', '/api/auth/signup', { email: 'other@corp.io', password: 'longpassword' });
  assert.equal((await api('GET', '/api/gtm/campaigns/1')).status, 404);
  assert.equal((await api('GET', '/api/lists/1')).status, 404);
  cookie = mine;
});
