'use strict';
// AutoGTM: website -> product analysis -> buyer segments -> prospects -> drafted emails
// -> human approval (default) -> sending from warmed inboxes -> replies -> meetings.
const { db, tx } = require('./db');
const ai = require('./ai');
const { searchCompanies, hydrate } = require('./search');
const credits = require('./credits');

const CFG = {
  tickMs: +(process.env.GTM_TICK_MS || 5000),
  prospectsPerSegment: +(process.env.GTM_PROSPECTS_PER_SEGMENT || 15),
  followUpAfterMs: +(process.env.GTM_FOLLOWUP_AFTER_MS || 60000),
  simulateReplies: process.env.GTM_SIMULATE_REPLIES !== 'false',
  replyDelayMs: +(process.env.GTM_REPLY_DELAY_MS || 15000),
  replyRate: +(process.env.GTM_SIM_REPLY_RATE || 0.2), // demo-only simulated reply rate
};

// Pluggable transport. Default records the send only. Replace with SMTP/SES/Gmail API in production.
const transport = {
  async send({ from, to, subject }) { console.log(`[gtm] simulated send ${from} -> ${to}: ${subject}`); return { id: `sim-${Date.now()}` }; },
};

const json = (v, d) => { try { return JSON.parse(v); } catch { return d; } };
const normaliseUrl = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`).replace(/\/+$/, '');

async function createCampaign(userId, body) {
  const website = normaliseUrl(String(body.website || '').trim());
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/.test(website)) throw Object.assign(new Error('Enter a valid website, e.g. acme.com'), { status: 400 });
  const analysis = await ai.analyzeWebsite(website);
  return tx(() => {
    const host = new URL(website).hostname.replace(/^www\./, '');
    const r = db.prepare(`INSERT INTO gtm_campaigns (user_id, website, product_summary, value_props, competitors, sender_name, sender_title, meeting_link, language, auto_approve, daily_limit, budget_usd)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(userId, website, analysis.product_summary, JSON.stringify(analysis.value_props), JSON.stringify(analysis.competitors),
      body.sender_name || 'Alex Morgan', body.sender_title || 'Founder', body.meeting_link || '', body.language || 'English', body.auto_approve ? 1 : 0, +(body.daily_limit || 50), +(body.budget_usd || 30));
    const cid = r.lastInsertRowid;
    const insS = db.prepare('INSERT INTO gtm_segments (campaign_id, name, rationale, fit_score, search_query, target_titles) VALUES (?,?,?,?,?,?)');
    for (const s of analysis.segments.sort((a, b) => b.fit_score - a.fit_score)) insS.run(cid, s.name, s.rationale, Math.max(0, Math.min(100, s.fit_score)), s.search_query, JSON.stringify(s.target_titles));
    // Separate sending domains protect the customer's primary domain reputation.
    const local = (body.sender_name || 'alex').split(' ')[0].toLowerCase().replace(/[^a-z]/g, '') || 'hello';
    const insI = db.prepare('INSERT INTO gtm_inboxes (campaign_id, address, warmup_score) VALUES (?,?,?)');
    ['try', 'get', 'meet'].forEach((p, i) => insI.run(cid, `${local}@${p}${host.split('.')[0]}.example`, 92 + i * 2));
    return getCampaign(userId, cid);
  });
}

function getCampaign(userId, id) {
  const c = db.prepare('SELECT * FROM gtm_campaigns WHERE id = ? AND user_id = ?').get(id, userId);
  if (!c) return null;
  const segments = db.prepare('SELECT * FROM gtm_segments WHERE campaign_id = ? ORDER BY fit_score DESC').all(id).map((s) => ({ ...s, target_titles: json(s.target_titles, []), metrics: segmentMetrics(s.id) }));
  const inboxes = db.prepare('SELECT * FROM gtm_inboxes WHERE campaign_id = ?').all(id);
  const funnel = db.prepare('SELECT stage, COUNT(*) n FROM gtm_prospects WHERE campaign_id = ? GROUP BY stage').all(id).reduce((a, r) => ({ ...a, [r.stage]: r.n }), {});
  const temps = db.prepare('SELECT lead_temp, COUNT(*) n FROM gtm_prospects WHERE campaign_id = ? AND lead_temp IS NOT NULL GROUP BY lead_temp').all(id).reduce((a, r) => ({ ...a, [r.lead_temp]: r.n }), {});
  const sent = db.prepare("SELECT COUNT(*) n FROM gtm_messages m JOIN gtm_prospects p ON p.id = m.prospect_id WHERE p.campaign_id = ? AND m.direction = 'out' AND m.status = 'sent'").get(id).n;
  const leads = (temps.hot || 0) + (temps.warm || 0);
  return { ...c, auto_approve: Boolean(c.auto_approve), value_props: json(c.value_props, []), competitors: json(c.competitors, []), segments, inboxes, funnel, temps, sent, leads,
    cost_per_lead_usd: leads ? +(c.spent_usd / leads).toFixed(2) : null };
}

function segmentMetrics(segmentId) {
  const r = db.prepare(`SELECT COUNT(DISTINCT p.id) prospects,
      SUM(CASE WHEN m.direction='out' AND m.status='sent' THEN 1 ELSE 0 END) sent,
      COUNT(DISTINCT CASE WHEN p.lead_temp IN ('hot','warm') THEN p.id END) leads,
      COUNT(DISTINCT CASE WHEN p.stage = 'meeting' THEN p.id END) meetings
    FROM gtm_prospects p LEFT JOIN gtm_messages m ON m.prospect_id = p.id WHERE p.segment_id = ?`).get(segmentId);
  const spent = (r.sent || 0) * credits.COSTS.gtm_email / 100;
  return { prospects: r.prospects || 0, sent: r.sent || 0, leads: r.leads || 0, meetings: r.meetings || 0, cost_per_lead_usd: r.leads ? +(spent / r.leads).toFixed(2) : null };
}

// Find prospects for a segment and draft step-1 emails.
async function activateSegment(userId, segmentId) {
  const seg = db.prepare('SELECT s.*, c.user_id FROM gtm_segments s JOIN gtm_campaigns c ON c.id = s.campaign_id WHERE s.id = ?').get(segmentId);
  if (!seg || seg.user_id !== userId) throw Object.assign(new Error('Segment not found'), { status: 404 });
  const campaign = db.prepare('SELECT * FROM gtm_campaigns WHERE id = ?').get(seg.campaign_id);
  const filters = await ai.parseQuery(seg.search_query);
  db.prepare("UPDATE gtm_segments SET filters = ?, status = 'working' WHERE id = ?").run(JSON.stringify(filters), segmentId);
  const { allIds } = searchCompanies(filters, { pageSize: 1 });
  const titles = json(seg.target_titles, []).map((t) => t.toLowerCase());
  const keyWords = [...new Set(titles.flatMap((t) => t.split(/[^a-z]+/)).filter((w) => w.length > 2 && !['and', 'the', 'head', 'of'].includes(w)))];
  const already = new Set(db.prepare('SELECT person_id FROM gtm_prospects WHERE campaign_id = ?').all(seg.campaign_id).map((r) => r.person_id));
  const picked = [];
  for (const cid of allIds) {
    if (picked.length >= CFG.prospectsPerSegment) break;
    const people = db.prepare("SELECT * FROM people WHERE company_id = ? AND email_status = 'verified'").all(cid);
    const best = people.map((p) => ({ p, s: keyWords.filter((w) => p.title.toLowerCase().includes(w)).length + (['Founder', 'C-Level'].includes(p.seniority) ? 0.5 : 0) }))
      .filter((x) => x.s > 0 && !already.has(x.p.id)).sort((a, b) => b.s - a.s)[0];
    if (best) picked.push(best.p); // one contact per company: no double-touching an account
  }
  const inboxes = db.prepare('SELECT id FROM gtm_inboxes WHERE campaign_id = ?').all(seg.campaign_id);
  const drafts = await Promise.all(picked.map(async (person) => {
    const company = hydrate(db.prepare('SELECT * FROM companies WHERE id = ?').get(person.company_id));
    return { person, email: await ai.writeEmail({ campaign, segment: seg, person, company }) };
  }));
  tx(() => {
    drafts.forEach(({ person, email }, i) => {
      const pr = db.prepare('INSERT OR IGNORE INTO gtm_prospects (campaign_id, segment_id, person_id, inbox_id, stage) VALUES (?,?,?,?,?)')
        .run(seg.campaign_id, segmentId, person.id, inboxes[i % inboxes.length].id, campaign.auto_approve ? 'approved' : 'pending_approval');
      if (pr.changes) db.prepare("INSERT INTO gtm_messages (prospect_id, direction, step, subject, body, status) VALUES (?, 'out', 1, ?, ?, ?)")
        .run(pr.lastInsertRowid, email.subject, email.body, campaign.auto_approve ? 'scheduled' : 'draft');
    });
  });
  return { added: drafts.length, filters };
}

function listProspects(userId, campaignId, { stage } = {}) {
  const own = db.prepare('SELECT id FROM gtm_campaigns WHERE id = ? AND user_id = ?').get(campaignId, userId);
  if (!own) return null;
  const rows = db.prepare(`SELECT pr.*, p.first_name, p.last_name, p.title, p.email, c.name company_name, c.domain company_domain, s.name segment_name, i.address inbox
    FROM gtm_prospects pr JOIN people p ON p.id = pr.person_id JOIN companies c ON c.id = p.company_id JOIN gtm_segments s ON s.id = pr.segment_id LEFT JOIN gtm_inboxes i ON i.id = pr.inbox_id
    WHERE pr.campaign_id = ? ${stage ? 'AND pr.stage = ?' : ''} ORDER BY pr.id DESC`).all(...(stage ? [campaignId, stage] : [campaignId]));
  const msgs = db.prepare('SELECT * FROM gtm_messages WHERE prospect_id = ? ORDER BY id');
  return rows.map((r) => ({ ...r, messages: msgs.all(r.id) }));
}

function ownsProspect(userId, prospectId) {
  return db.prepare('SELECT pr.* FROM gtm_prospects pr JOIN gtm_campaigns c ON c.id = pr.campaign_id WHERE pr.id = ? AND c.user_id = ?').get(prospectId, userId);
}

function reviewProspect(userId, prospectId, { action, subject, body }) {
  const pr = ownsProspect(userId, prospectId);
  if (!pr) throw Object.assign(new Error('Prospect not found'), { status: 404 });
  const draft = db.prepare("SELECT * FROM gtm_messages WHERE prospect_id = ? AND direction = 'out' AND status = 'draft' ORDER BY id DESC").get(prospectId);
  if (subject != null || body != null) {
    if (!draft) throw Object.assign(new Error('No draft to edit'), { status: 409 });
    db.prepare('UPDATE gtm_messages SET subject = COALESCE(?, subject), body = COALESCE(?, body) WHERE id = ?').run(subject ?? null, body ?? null, draft.id);
  }
  if (action === 'approve') {
    if (draft) db.prepare("UPDATE gtm_messages SET status = 'scheduled' WHERE id = ?").run(draft.id);
    if (pr.stage === 'pending_approval') db.prepare("UPDATE gtm_prospects SET stage = 'approved' WHERE id = ?").run(prospectId);
  } else if (action === 'reject') {
    db.prepare("UPDATE gtm_prospects SET stage = 'rejected' WHERE id = ?").run(prospectId);
    db.prepare("DELETE FROM gtm_messages WHERE prospect_id = ? AND status IN ('draft','scheduled')").run(prospectId);
  }
  return ownsProspect(userId, prospectId);
}

function reply(userId, prospectId, { subject, body }) {
  const pr = ownsProspect(userId, prospectId);
  if (!pr) throw Object.assign(new Error('Prospect not found'), { status: 404 });
  db.prepare("INSERT INTO gtm_messages (prospect_id, direction, step, subject, body, status) VALUES (?, 'out', 99, ?, ?, 'scheduled')").run(prospectId, subject, body);
  return { ok: true };
}

function setMeeting(userId, prospectId) {
  const pr = ownsProspect(userId, prospectId);
  if (!pr) throw Object.assign(new Error('Prospect not found'), { status: 404 });
  db.prepare("UPDATE gtm_prospects SET stage = 'meeting', lead_temp = 'hot' WHERE id = ?").run(prospectId);
  return ownsProspect(userId, prospectId);
}

// ---------------------------------------------------------------- worker
const SIM_REPLIES = [
  ['hot', 'This is timely. Can you send a couple of times for a call next Tuesday or Thursday?'],
  ['warm', 'Interesting. What does pricing look like for a team our size?'],
  ['not_interested', 'Thanks, but not a fit for us right now.'],
  ['out_of_office', 'I am out of office until Monday and will reply when I am back.'],
];

async function tick() {
  const running = db.prepare("SELECT * FROM gtm_campaigns WHERE status = 'running'").all();
  for (const camp of running) {
    const dueFollowUps = db.prepare(`SELECT pr.* FROM gtm_prospects pr WHERE pr.campaign_id = ? AND pr.stage = 'sent'
      AND NOT EXISTS (SELECT 1 FROM gtm_messages m WHERE m.prospect_id = pr.id AND (m.step >= 2 OR m.direction = 'in'))
      AND (SELECT MAX(sent_at) FROM gtm_messages m WHERE m.prospect_id = pr.id) <= ?`).all(camp.id, new Date(Date.now() - CFG.followUpAfterMs).toISOString());
    for (const pr of dueFollowUps) {
      const seg = db.prepare('SELECT * FROM gtm_segments WHERE id = ?').get(pr.segment_id);
      const person = db.prepare('SELECT * FROM people WHERE id = ?').get(pr.person_id);
      const company = hydrate(db.prepare('SELECT * FROM companies WHERE id = ?').get(person.company_id));
      const e = await ai.writeEmail({ campaign: camp, segment: seg, person, company, step: 2 });
      db.prepare("INSERT INTO gtm_messages (prospect_id, direction, step, subject, body, status) VALUES (?, 'out', 2, ?, ?, ?)").run(pr.id, e.subject, e.body, camp.auto_approve ? 'scheduled' : 'draft');
      if (!camp.auto_approve) db.prepare("UPDATE gtm_prospects SET stage = 'pending_approval' WHERE id = ?").run(pr.id);
    }

    const queue = db.prepare(`SELECT m.*, pr.inbox_id, pr.segment_id, p.email to_email, i.address from_addr, s.status seg_status
      FROM gtm_messages m JOIN gtm_prospects pr ON pr.id = m.prospect_id JOIN people p ON p.id = pr.person_id
      JOIN gtm_inboxes i ON i.id = pr.inbox_id JOIN gtm_segments s ON s.id = pr.segment_id
      WHERE pr.campaign_id = ? AND m.status = 'scheduled' AND s.status != 'paused' ORDER BY m.id LIMIT 20`).all(camp.id);
    for (const m of queue) {
      const inbox = db.prepare('SELECT * FROM gtm_inboxes WHERE id = ?').get(m.inbox_id);
      if (inbox.sent_today >= Math.ceil(camp.daily_limit / 3)) continue;
      const usd = credits.COSTS.gtm_email / 100;
      if (camp.spent_usd + usd > camp.budget_usd + 1e-9) { db.prepare("UPDATE gtm_campaigns SET status = 'paused' WHERE id = ?").run(camp.id); break; }
      try { credits.charge(camp.user_id, credits.COSTS.gtm_email, 'gtm_email', `msg:${m.id}`); }
      catch { db.prepare("UPDATE gtm_campaigns SET status = 'paused' WHERE id = ?").run(camp.id); break; }
      await transport.send({ from: m.from_addr, to: m.to_email, subject: m.subject, body: m.body });
      const now = new Date().toISOString();
      tx(() => {
        db.prepare("UPDATE gtm_messages SET status = 'sent', sent_at = ? WHERE id = ?").run(now, m.id);
        db.prepare("UPDATE gtm_prospects SET stage = CASE WHEN stage IN ('approved','pending_approval') THEN 'sent' ELSE stage END WHERE id = ?").run(m.prospect_id);
        db.prepare('UPDATE gtm_inboxes SET sent_today = sent_today + 1 WHERE id = ?').run(m.inbox_id);
        db.prepare('UPDATE gtm_campaigns SET spent_usd = spent_usd + ? WHERE id = ?').run(usd, camp.id);
        camp.spent_usd += usd;
      });
    }

    if (CFG.simulateReplies) await simulateReplies(camp);
    autoTuneSegments(camp.id);
  }
}

async function simulateReplies(camp) {
  const candidates = db.prepare(`SELECT pr.* FROM gtm_prospects pr WHERE pr.campaign_id = ? AND pr.stage = 'sent' AND pr.lead_temp IS NULL
    AND (SELECT MIN(sent_at) FROM gtm_messages m WHERE m.prospect_id = pr.id AND m.status = 'sent') <= ?`).all(camp.id, new Date(Date.now() - CFG.replyDelayMs).toISOString());
  for (const pr of candidates) {
    const roll = (pr.person_id * 2654435761 % 100) / 100; // deterministic per prospect
    let label = 'cold';
    if (roll < CFG.replyRate) {
      const [, text] = SIM_REPLIES[pr.person_id % SIM_REPLIES.length];
      label = await ai.classifyReply(text);
      db.prepare("INSERT INTO gtm_messages (prospect_id, direction, step, subject, body, status, classification) VALUES (?, 'in', 1, 'Re:', ?, 'received', ?)").run(pr.id, text, label);
      db.prepare("UPDATE gtm_prospects SET stage = 'replied' WHERE id = ?").run(pr.id);
      if (label === 'hot') {
        db.prepare("INSERT INTO gtm_messages (prospect_id, direction, step, subject, body, status) VALUES (?, 'out', 99, 'Re: times', ?, ?)")
          .run(pr.id, `Great to hear. ${camp.meeting_link ? `Grab any slot here: ${camp.meeting_link}` : 'Does Tuesday 11:00 or Thursday 15:00 work?'}\n\n${camp.sender_name}`, camp.auto_approve ? 'scheduled' : 'draft');
      }
    }
    db.prepare('UPDATE gtm_prospects SET lead_temp = ? WHERE id = ?').run(label === 'out_of_office' ? null : label === 'unsubscribe' ? 'not_interested' : label, pr.id);
    if (label === 'out_of_office') db.prepare("UPDATE gtm_prospects SET lead_temp = 'cold' WHERE id = ?").run(pr.id);
  }
}

// Segments that convert get budget priority ("scaling"); the user can always pause.
function autoTuneSegments(campaignId) {
  for (const s of db.prepare("SELECT * FROM gtm_segments WHERE campaign_id = ? AND status IN ('working','scaling')").all(campaignId)) {
    const m = segmentMetrics(s.id);
    const next = m.sent >= 10 && m.leads / m.sent >= 0.05 ? 'scaling' : 'working';
    if (next !== s.status) db.prepare('UPDATE gtm_segments SET status = ? WHERE id = ?').run(next, s.id);
  }
}

let timer = null;
function startWorker() {
  if (timer) return;
  let busy = false;
  timer = setInterval(async () => { if (busy) return; busy = true; try { await tick(); } catch (e) { console.error('[gtm] tick failed', e); } finally { busy = false; } }, CFG.tickMs);
  timer.unref();
  // Reset daily send counters at UTC midnight.
  setInterval(() => { if (new Date().getUTCHours() === 0) db.prepare('UPDATE gtm_inboxes SET sent_today = 0').run(); }, 3600e3).unref();
}

module.exports = { createCampaign, getCampaign, activateSegment, listProspects, reviewProspect, reply, setMeeting, tick, startWorker, transport, CFG };
