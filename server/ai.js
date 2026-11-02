'use strict';
// AI layer. Uses Claude when ANTHROPIC_API_KEY (or another SDK credential) is configured,
// otherwise deterministic heuristics so the whole product still works offline.
const { INDUSTRIES, GEO, STAGES, TECH } = require('./seed');

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
let client = null;
function getClient() {
  if (client !== null) return client;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return (client = false);
  try { const Anthropic = require('@anthropic-ai/sdk'); client = new (Anthropic.default || Anthropic)(); }
  catch { client = false; }
  return client;
}
const aiEnabled = () => Boolean(getClient());

// One structured-output call. Returns parsed JSON or null (caller falls back to heuristics).
async function claudeJSON(system, user, schema, { effort = 'low', maxTokens = 4000 } = {}) {
  const c = getClient();
  if (!c) return null;
  try {
    const res = await c.beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return null;
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  } catch (e) {
    console.error('[ai] Claude call failed, using heuristic fallback:', e.status || '', e.message);
    return null;
  }
}

// ---------------------------------------------------------------- query parsing
const COUNTRY_ALIASES = { 'us': 'United States', 'usa': 'United States', 'america': 'United States', 'uk': 'United Kingdom', 'britain': 'United Kingdom', 'england': 'United Kingdom', 'uae': 'United Arab Emirates', 'emirates': 'United Arab Emirates', 'holland': 'Netherlands' };
const INDUSTRY_ALIASES = {
  'saas': 'SaaS', 'software': 'SaaS', 'ai': 'Artificial Intelligence', 'artificial intelligence': 'Artificial Intelligence', 'machine learning': 'Artificial Intelligence', 'llm': 'Artificial Intelligence',
  'fintech': 'Fintech', 'payments': 'Fintech', 'cybersecurity': 'Cybersecurity', 'security': 'Cybersecurity', 'ecommerce': 'E-commerce', 'e-commerce': 'E-commerce', 'dtc': 'E-commerce', 'shopify': 'E-commerce',
  'agency': 'Marketing Agency', 'agencies': 'Marketing Agency', 'marketing': 'Marketing Agency', 'healthtech': 'Healthtech', 'health': 'Healthtech', 'healthcare': 'Healthtech', 'edtech': 'Edtech', 'education': 'Edtech', 'study abroad': 'Edtech',
  'logistics': 'Logistics', 'freight': 'Logistics', 'real estate': 'Real Estate', 'proptech': 'Real Estate', 'manufacturing': 'Manufacturing', 'manufacturers': 'Manufacturing',
  'wedding': 'Events & Weddings', 'weddings': 'Events & Weddings', 'event': 'Events & Weddings', 'events': 'Events & Weddings', 'florist': 'Events & Weddings', 'floral': 'Events & Weddings',
  'hr': 'HR Tech', 'recruiting': 'HR Tech', 'payroll': 'HR Tech', 'consulting': 'Consulting', 'consultancy': 'Consulting', 'revops': 'Consulting',
};
const STOP = new Set('a an the and or of in on at for with to from that are is be by companies company startups startup businesses business firms find show me list based located who which using use than less more under over around about employees employee people staff team size'.split(' '));

function emptyFilters() {
  return { industries: [], countries: [], cities: [], employees_min: null, employees_max: null, funding_stages: [], recently_funded: false, technologies: [], business_model: null, remote_policy: null, keywords: [] };
}

function heuristicParse(q) {
  const f = emptyFilters();
  let s = ` ${q.toLowerCase()} `;
  const take = (re) => { const m = s.match(re); if (m) s = s.replace(m[0], ' '); return m; };
  let m;
  if ((m = take(/(?:under|less than|fewer than|below|<)\s*(\d[\d,]*)\s*(?:employees|people|staff)?/))) f.employees_max = +m[1].replace(/,/g, '');
  if ((m = take(/(?:over|more than|above|>)\s*(\d[\d,]*)\s*(?:employees|people|staff)?/))) f.employees_min = +m[1].replace(/,/g, '');
  if ((m = take(/(\d[\d,]*)\s*(?:-|to)\s*(\d[\d,]*)\s*(?:employees|people|staff)/))) { f.employees_min = +m[1].replace(/,/g, ''); f.employees_max = +m[2].replace(/,/g, ''); }
  if (take(/\bsmall\b|\bsmb\b/)) f.employees_max = f.employees_max ?? 50;
  if (take(/\benterprise\b|\blarge\b/)) f.employees_min = f.employees_min ?? 1000;
  if (take(/\bmid[- ]?market\b/)) { f.employees_min = 200; f.employees_max = 2000; }
  if (take(/recently (?:funded|raised)|just raised|new funding/)) f.recently_funded = true;
  for (const st of STAGES) if (take(new RegExp(`\\b${st.toLowerCase().replace('+', '\\+')}\\b`))) f.funding_stages.push(st);
  if (take(/\bbootstrapped\b/) && !f.funding_stages.includes('Bootstrapped')) f.funding_stages.push('Bootstrapped');
  if (take(/\bfully remote\b|\bremote(?:-first)?\b/)) f.remote_policy = 'Remote';
  else if (take(/\bhybrid\b/)) f.remote_policy = 'Hybrid';
  if (take(/\bb2b\b/)) f.business_model = 'B2B';
  else if (take(/\bb2c\b|\bconsumer\b/)) f.business_model = 'B2C';
  else if (take(/\bmarketplaces?\b/)) f.business_model = 'Marketplace';
  for (const country of Object.keys(GEO)) {
    if (take(new RegExp(`\\b${country.toLowerCase()}\\b`))) f.countries.push(country);
    for (const city of GEO[country]) if (take(new RegExp(`\\b${city.toLowerCase()}\\b`))) f.cities.push(city);
  }
  for (const [alias, country] of Object.entries(COUNTRY_ALIASES)) if (take(new RegExp(`\\b${alias}\\b`)) && !f.countries.includes(country)) f.countries.push(country);
  for (const t of TECH) if (take(new RegExp(`\\b${t.toLowerCase().replace('.', '\\.')}\\b`))) f.technologies.push(t);
  for (const [alias, ind] of Object.entries(INDUSTRY_ALIASES).sort((a, b) => b[0].length - a[0].length)) {
    if (take(new RegExp(`\\b${alias}\\b`)) && !f.industries.includes(ind)) f.industries.push(ind);
  }
  f.keywords.push(...s.split(/[^a-z0-9+#.-]+/).filter((w) => w.length > 2 && !STOP.has(w)));
  f.keywords = [...new Set(f.keywords)];
  return f;
}

const FILTER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['industries', 'countries', 'cities', 'employees_min', 'employees_max', 'funding_stages', 'recently_funded', 'technologies', 'business_model', 'remote_policy', 'keywords'],
  properties: {
    industries: { type: 'array', items: { type: 'string', enum: Object.keys(INDUSTRIES) } },
    countries: { type: 'array', items: { type: 'string', enum: Object.keys(GEO) } },
    cities: { type: 'array', items: { type: 'string' } },
    employees_min: { type: ['integer', 'null'] },
    employees_max: { type: ['integer', 'null'] },
    funding_stages: { type: 'array', items: { type: 'string', enum: STAGES } },
    recently_funded: { type: 'boolean' },
    technologies: { type: 'array', items: { type: 'string', enum: TECH } },
    business_model: { type: ['string', 'null'], enum: ['B2B', 'B2C', 'Marketplace', null] },
    remote_policy: { type: ['string', 'null'], enum: ['Remote', 'Hybrid', 'Onsite', null] },
    keywords: { type: 'array', items: { type: 'string' }, description: 'Lowercase descriptive terms not covered by other fields, matched against company descriptions and tags.' },
  },
};

async function parseQuery(q) {
  const ai = await claudeJSON(
    'You convert a plain-English B2B company search into structured filters for a company database. Only use filter values that the query clearly implies. Put remaining meaningful descriptors (e.g. "tiktok", "subscription", "wedding") into keywords.',
    `Query: ${q}`, FILTER_SCHEMA);
  return ai ? { ...emptyFilters(), ...ai, _source: 'claude' } : { ...heuristicParse(q), _source: 'heuristic' };
}

// ---------------------------------------------------------------- AI criteria (custom yes/no columns)
function companyCard(c) {
  return `${c.name} (${c.domain}) | ${c.industry} | ${c.city}, ${c.country} | ${c.employees} employees | ${c.funding_stage} | model ${c.business_model} | ${c.remote_policy} | tags: ${c.tags.join(', ')} | tech: ${c.technologies.join(', ')} | ${c.description}`;
}

const FILLER = new Set('does have they this their them its company focus focused focuses sell sells offer offers work works specialised specialized specialise specialize provide provides using model any into mainly primarily mostly operate operates kind type based services service'.split(' '));
const stem = (w) => w.replace(/ies$/, 'y').replace(/(ing|ed|es|s)$/, '');

function heuristicCriterion(c, criterion) {
  const text = companyCard(c).toLowerCase();
  const words = criterion.toLowerCase().replace(/[?.!,]/g, '').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !FILLER.has(w));
  if (!words.length) return { verdict: 'unsure', reason: 'Criterion too vague to check without AI.' };
  const hits = words.filter((w) => text.includes(stem(w)));
  const ratio = hits.length / words.length;
  if (ratio >= 0.5) return { verdict: 'yes', reason: `Profile mentions ${hits.join(', ')}.` };
  if (ratio === 0) return { verdict: 'no', reason: `No evidence of ${words.slice(0, 3).join(', ')} in profile.` };
  return { verdict: 'unsure', reason: `Partial match on ${hits.join(', ')}.` };
}

async function evaluateCriteria(companies, criteria) {
  // Batch: one call evaluates every criterion for up to 25 companies.
  const out = new Map();
  const batches = [];
  for (let i = 0; i < companies.length; i += 25) batches.push(companies.slice(i, i + 25));
  await Promise.all(batches.map(async (batch) => {
    const ai = aiEnabled() ? await claudeJSON(
      'You are a B2B research analyst. For each company and each criterion, answer yes, no or unsure based only on the profile given. Give a reason of at most 15 words. Say unsure when the profile does not contain the evidence.',
      `Criteria:\n${criteria.map((c, i) => `${i}. ${c}`).join('\n')}\n\nCompanies:\n${batch.map((c) => `[${c.id}] ${companyCard(c)}`).join('\n')}`,
      { type: 'object', additionalProperties: false, required: ['results'], properties: { results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['company_id', 'criterion_idx', 'verdict', 'reason'], properties: { company_id: { type: 'integer' }, criterion_idx: { type: 'integer' }, verdict: { type: 'string', enum: ['yes', 'no', 'unsure'] }, reason: { type: 'string' } } } } } },
      { maxTokens: 8000 }) : null;
    for (const c of batch) criteria.forEach((cr, idx) => {
      const hit = ai?.results.find((r) => r.company_id === c.id && r.criterion_idx === idx);
      out.set(`${c.id}:${idx}`, hit ? { verdict: hit.verdict, reason: hit.reason } : heuristicCriterion(c, cr));
    });
  }));
  return out;
}

// ---------------------------------------------------------------- AutoGTM: website analysis
async function fetchSiteText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'LeadscopeBot/1.0 (+product analysis for account owner)' } });
    const html = await res.text();
    const title = (html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '';
    const meta = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || '';
    const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { title, meta, body: body.slice(0, 12000) };
  } catch { return { title: '', meta: '', body: '' }; }
}

const ANALYSIS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['product_summary', 'value_props', 'competitors', 'segments'],
  properties: {
    product_summary: { type: 'string' },
    value_props: { type: 'array', items: { type: 'string' } },
    competitors: { type: 'array', items: { type: 'string' } },
    segments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'rationale', 'fit_score', 'search_query', 'target_titles'], properties: {
      name: { type: 'string' }, rationale: { type: 'string' }, fit_score: { type: 'integer' },
      search_query: { type: 'string', description: 'Plain-English company search that finds this segment, e.g. "wedding planners in the UK under 50 employees"' },
      target_titles: { type: 'array', items: { type: 'string' } } } } },
  },
};

function heuristicAnalysis(url, site) {
  const text = `${site.title} ${site.meta} ${site.body} ${url}`.toLowerCase();
  const scored = Object.entries(INDUSTRY_ALIASES).map(([alias, ind]) => ({ ind, n: text.split(alias).length - 1 })).filter((x) => x.n > 0);
  const own = scored.sort((a, b) => b.n - a.n)[0]?.ind || 'SaaS';
  // Who buys from a company in industry X: simple adjacency map.
  const BUYERS = {
    'SaaS': ['SaaS', 'Fintech', 'E-commerce', 'Marketing Agency'], 'Artificial Intelligence': ['SaaS', 'Fintech', 'Healthtech', 'Logistics'], 'Fintech': ['E-commerce', 'SaaS', 'Real Estate'],
    'Cybersecurity': ['Fintech', 'Healthtech', 'SaaS'], 'E-commerce': ['Events & Weddings', 'E-commerce', 'Marketing Agency'], 'Marketing Agency': ['E-commerce', 'SaaS', 'Edtech'],
    'Healthtech': ['Healthtech', 'HR Tech'], 'Edtech': ['Edtech', 'Consulting', 'HR Tech'], 'Logistics': ['E-commerce', 'Manufacturing'], 'Real Estate': ['Consulting', 'Fintech'],
    'Manufacturing': ['E-commerce', 'Logistics', 'Events & Weddings'], 'Events & Weddings': ['Events & Weddings', 'Real Estate'], 'HR Tech': ['SaaS', 'Consulting', 'Logistics'], 'Consulting': ['SaaS', 'Fintech', 'Manufacturing'],
  }[own];
  const titles = { 'Events & Weddings': ['Owner', 'Creative Director', 'Lead Planner'], 'E-commerce': ['Founder & CEO', 'Head of Growth', 'Head of Procurement'] };
  const host = new URL(url).hostname.replace(/^www\./, '');
  const brand = host.split('.')[0].replace(/[-_]/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  return {
    product_summary: site.meta || site.title || `${brand} (${host})`,
    value_props: [site.meta, site.title].filter(Boolean).slice(0, 2),
    competitors: [],
    segments: BUYERS.map((ind, i) => ({
      name: `${ind} companies`, rationale: `Companies in ${ind} commonly buy from ${own} vendors.`, fit_score: 92 - i * 5,
      search_query: `${ind} companies`, target_titles: titles[ind] || ['Founder & CEO', 'VP of Sales', 'Head of Growth', 'Director of Operations'],
    })),
  };
}

async function analyzeWebsite(url) {
  const site = await fetchSiteText(url);
  const ai = await claudeJSON(
    `You are a go-to-market strategist. From a company's website, work out what it sells, its value propositions, likely competitors, and 3 to 5 distinct buyer segments ranked by fit (0-100). Each segment needs a plain-English company search query and 2-4 job titles of the decision maker. Industries available in the database: ${Object.keys(INDUSTRIES).join(', ')}.`,
    `Website: ${url}\nTitle: ${site.title}\nMeta: ${site.meta}\nText: ${site.body || '(could not fetch page; infer from the domain)'}`,
    ANALYSIS_SCHEMA, { effort: 'medium', maxTokens: 8000 });
  return ai ? { ...ai, _source: 'claude' } : { ...heuristicAnalysis(url, site), _source: 'heuristic' };
}

// ---------------------------------------------------------------- AutoGTM: email writing
async function writeEmail({ campaign, segment, person, company, step = 1 }) {
  const ai = await claudeJSON(
    `You write short, specific B2B cold emails. Under 110 words. Plain text, no markdown, no buzzwords, no em dashes. Open with something specific about the prospect's company. One clear ask: a 15 minute call${campaign.meeting_link ? ' using the meeting link' : ''}. Write in ${campaign.language || 'English'}. ${step > 1 ? 'This is a follow-up: shorter, reference the previous email.' : ''}`,
    `Sender: ${campaign.sender_name}, ${campaign.sender_title}\nWhat we sell: ${campaign.product_summary}\nValue props: ${JSON.parse(campaign.value_props || '[]').join('; ')}\nSegment: ${segment.name} (${segment.rationale})\nProspect: ${person.first_name} ${person.last_name}, ${person.title}\nCompany: ${companyCard(company)}\nMeeting link: ${campaign.meeting_link || 'none'}`,
    { type: 'object', additionalProperties: false, required: ['subject', 'body'], properties: { subject: { type: 'string' }, body: { type: 'string' } } });
  if (ai) return ai;
  const vp = JSON.parse(campaign.value_props || '[]')[0];
  const brand = campaign.product_summary.split(/[.,(]/)[0].trim().slice(0, 40);
  if (step > 1) return { subject: `Re: ${company.name} x ${campaign.sender_name.split(' ')[0]}`, body: `Hi ${person.first_name},\n\nFloating this back up. If ${segment.name.toLowerCase()} like ${company.name} is not a fit, just tell me and I will close the loop.\n\n${campaign.sender_name}` };
  return {
    subject: `${company.name} x ${brand}`,
    body: `Hi ${person.first_name},\n\nSaw that ${company.name} is a ${company.description.replace(/^.*? is an? /, '').replace(/\.$/, '')} based in ${company.city}. ${vp ? `We help ${segment.name.toLowerCase()} with one thing: ${vp.replace(/\.$/, '').toLowerCase()}.` : `${brand} works with ${segment.name.toLowerCase()} like yours, and I think there is a fit.`}\n\nWorth a 15 minute call to see if it fits ${company.name}?${campaign.meeting_link ? `\n\nPick a time: ${campaign.meeting_link}` : ''}\n\n${campaign.sender_name}\n${campaign.sender_title}`,
  };
}

// ---------------------------------------------------------------- reply classification
async function classifyReply(text) {
  const ai = await claudeJSON('Classify a reply to a cold email.', text, { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string', enum: ['hot', 'warm', 'not_interested', 'out_of_office', 'unsubscribe'] } } }, { maxTokens: 500 });
  if (ai) return ai.label;
  const t = text.toLowerCase();
  if (/unsubscribe|remove me|stop emailing/.test(t)) return 'unsubscribe';
  if (/out of office|on leave|vacation|returning/.test(t)) return 'out_of_office';
  if (/not interested|no thanks|not a fit|no need/.test(t)) return 'not_interested';
  if (/book|call|meet|calendar|tuesday|thursday|sounds good|let'?s talk|send (me )?(a )?time/.test(t)) return 'hot';
  return 'warm';
}

module.exports = { aiEnabled, parseQuery, heuristicParse, evaluateCriteria, heuristicCriterion, analyzeWebsite, writeEmail, classifyReply, companyCard, emptyFilters, MODEL };
