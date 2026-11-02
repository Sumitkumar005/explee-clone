'use strict';
// Deterministic synthetic B2B dataset. All companies, people and emails are fictional
// and use the reserved .example TLD so nothing here can be mistaken for real contact data.
// Swap this for a licensed provider (see docs/ARCHITECTURE.md -> "Data providers").
const { db, tx } = require('./db');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const INDUSTRIES = {
  'SaaS': { tags: ['subscription', 'cloud software', 'B2B SaaS', 'API-first', 'PLG'], desc: ['workflow automation platform for {aud}', 'analytics dashboard for {aud}', 'collaboration software used by {aud}', 'billing and subscription platform for {aud}'] },
  'Artificial Intelligence': { tags: ['develops AI', 'LLM', 'machine learning', 'computer vision', 'AI agents'], desc: ['AI agents that automate {task} for {aud}', 'machine learning models that predict {task} for {aud}', 'generative AI copilot for {aud}'] },
  'Fintech': { tags: ['payments', 'lending', 'regtech', 'banking-as-a-service', 'expense management'], desc: ['payments infrastructure for {aud}', 'lending platform serving {aud}', 'expense management app for {aud}'] },
  'Cybersecurity': { tags: ['zero trust', 'SOC', 'identity', 'compliance automation', 'endpoint security'], desc: ['identity and access management for {aud}', 'automated SOC 2 compliance for {aud}', 'threat detection for {aud}'] },
  'E-commerce': { tags: ['DTC', 'Shopify', 'marketplace', 'subscription box', 'retail'], desc: ['direct-to-consumer brand selling {prod}', 'online marketplace for {prod}', 'Shopify-native store selling {prod}'] },
  'Marketing Agency': { tags: ['agency', 'performance marketing', 'TikTok growth', 'SEO', 'paid social', 'influencer'], desc: ['performance marketing agency for {aud}', 'TikTok growth agency for e-commerce brands', 'SEO and content agency for {aud}', 'influencer marketing agency for {aud}'] },
  'Healthtech': { tags: ['digital health', 'telemedicine', 'EHR', 'medtech', 'HIPAA'], desc: ['telemedicine platform for {aud}', 'patient engagement software for {aud}', 'clinical workflow tools for {aud}'] },
  'Edtech': { tags: ['online learning', 'LMS', 'study abroad', 'upskilling', 'K-12'], desc: ['online learning platform for {aud}', 'study abroad admissions platform for {aud}', 'corporate upskilling programs for {aud}'] },
  'Logistics': { tags: ['freight', 'last mile', 'supply chain', 'fleet management', 'warehousing'], desc: ['freight brokerage software for {aud}', 'last-mile delivery network for {aud}', 'supply chain visibility platform for {aud}'] },
  'Real Estate': { tags: ['proptech', 'property management', 'brokerage', 'coworking'], desc: ['property management software for {aud}', 'proptech marketplace for {aud}'] },
  'Manufacturing': { tags: ['industrial', 'IoT', 'contract manufacturing', 'automation'], desc: ['contract manufacturer of {prod}', 'industrial IoT sensors for {aud}'] },
  'Events & Weddings': { tags: ['event design', 'wedding planning', 'floral studio', 'venues', 'hospitality'], desc: ['event design studio for {aud}', 'wedding planning company serving {aud}', 'floral studio specialising in weddings and events', 'venue and hospitality group hosting {aud}'] },
  'HR Tech': { tags: ['recruiting', 'payroll', 'ATS', 'employee engagement', 'remote hiring'], desc: ['recruiting software for {aud}', 'global payroll for {aud}', 'remote hiring platform for {aud}'] },
  'Consulting': { tags: ['management consulting', 'IT services', 'outsourcing', 'RevOps'], desc: ['RevOps consultancy for {aud}', 'IT services partner for {aud}', 'management consulting for {aud}'] },
};
const AUD = ['mid-market finance teams', 'SMB retailers', 'enterprise IT', 'startups', 'hospitals and clinics', 'universities', 'e-commerce brands', 'sales teams', 'HR leaders', 'logistics operators', 'agencies', 'restaurants', 'law firms', 'manufacturers', 'couples and event planners', 'international students'];
const TASKS = ['churn', 'fraud', 'demand', 'lead scoring', 'invoice processing', 'customer support', 'hiring'];
const PRODS = ['skincare', 'artificial silk flowers', 'pet food', 'coffee', 'apparel', 'home fitness gear', 'furniture', 'supplements', 'electronics accessories'];
const TECH = ['React', 'Next.js', 'Node.js', 'Python', 'AWS', 'GCP', 'Azure', 'Kubernetes', 'Snowflake', 'Salesforce', 'HubSpot', 'Stripe', 'Shopify', 'Segment', 'Intercom', 'Zendesk', 'OpenAI', 'Anthropic', 'PostgreSQL', 'Webflow', 'WordPress', 'Klaviyo', 'Google Analytics'];
const GEO = {
  'United States': ['San Francisco', 'New York', 'Austin', 'Boston', 'Seattle', 'Chicago', 'Miami'],
  'United Kingdom': ['London', 'Manchester', 'Edinburgh', 'Bristol'],
  'Germany': ['Berlin', 'Munich', 'Hamburg'],
  'France': ['Paris', 'Lyon'],
  'India': ['Bengaluru', 'Mumbai', 'Delhi', 'Kolkata', 'Pune', 'Hyderabad'],
  'Canada': ['Toronto', 'Vancouver', 'Montreal'],
  'Australia': ['Sydney', 'Melbourne'],
  'Netherlands': ['Amsterdam', 'Rotterdam'],
  'Spain': ['Madrid', 'Barcelona'],
  'Singapore': ['Singapore'],
  'United Arab Emirates': ['Dubai', 'Abu Dhabi'],
  'Hungary': ['Budapest'],
  'Brazil': ['São Paulo'],
  'Israel': ['Tel Aviv'],
};
const STAGES = ['Bootstrapped', 'Pre-seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Series D+', 'Public'];
const SYL = ['nov', 'ari', 'qua', 'lum', 'zen', 'vex', 'ora', 'tri', 'kel', 'mor', 'pix', 'sol', 'dra', 'fin', 'bry', 'cal', 'eon', 'hal', 'ive', 'jun', 'lyt', 'nex', 'opt', 'ryn', 'syn', 'tal', 'ula', 'vor', 'wyn', 'xel'];
const SUFFIX = ['', 'ly', 'ify', 'io', 'labs', 'hq', 'works', 'base', 'stack', 'flow', 'ai', 'hub'];
const FIRST = ['Aarav', 'Priya', 'James', 'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Lucas', 'Mia', 'Ethan', 'Sofia', 'Arjun', 'Ananya', 'Mateo', 'Chloe', 'Leon', 'Hannah', 'Yusuf', 'Fatima', 'Daniel', 'Grace', 'Ravi', 'Meera', 'Tom', 'Zoe', 'Ben', 'Isla', 'Omar', 'Lea', 'Kenji', 'Aiko', 'Diego', 'Laura', 'Sam', 'Nina'];
const LAST = ['Sharma', 'Patel', 'Smith', 'Johnson', 'Müller', 'Garcia', 'Brown', 'Kumar', 'Martin', 'Rossi', 'Cohen', 'Nguyen', 'Silva', 'Taylor', 'Wilson', 'Khan', 'Mehta', 'Dubois', 'Novak', 'Jensen', 'Okafor', 'Tanaka', 'Singh', 'Lopez', 'Clarke', 'Bose'];
const ROLES = [
  ['Founder & CEO', 'Founder', 'Executive'], ['Co-founder & CTO', 'Founder', 'Engineering'], ['Chief Revenue Officer', 'C-Level', 'Sales'],
  ['VP of Sales', 'VP', 'Sales'], ['VP of Marketing', 'VP', 'Marketing'], ['Head of Growth', 'Head', 'Marketing'], ['Head of Partnerships', 'Head', 'Business Development'],
  ['Director of Operations', 'Director', 'Operations'], ['Head of Procurement', 'Head', 'Operations'], ['Head of People', 'Head', 'HR'],
  ['Sales Manager', 'Manager', 'Sales'], ['Marketing Manager', 'Manager', 'Marketing'], ['Account Executive', 'IC', 'Sales'], ['CFO', 'C-Level', 'Finance'],
  ['Creative Director', 'Director', 'Design'], ['Owner', 'Founder', 'Executive'], ['Lead Planner', 'Manager', 'Operations'], ['Head of Engineering', 'Head', 'Engineering'],
];

const pick = (r, a) => a[Math.floor(r() * a.length)];
const sample = (r, a, n) => { const c = [...a]; const out = []; while (out.length < n && c.length) out.push(c.splice(Math.floor(r() * c.length), 1)[0]); return out; };
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

function seed({ companies = 6000, seedValue = 42 } = {}) {
  const have = db.prepare('SELECT COUNT(*) n FROM companies').get().n;
  if (have > 0) return { skipped: true, companies: have };
  const r = rng(seedValue);
  const insC = db.prepare(`INSERT OR IGNORE INTO companies (name, domain, description, industry, tags, technologies, country, city, employees, revenue_usd, funding_stage, funding_total_usd, last_funding_date, founded_year, business_model, remote_policy, hiring_open_roles, linkedin_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insP = db.prepare(`INSERT INTO people (company_id, first_name, last_name, title, seniority, department, email, email_status, phone, linkedin_url, country, city) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const industries = Object.keys(INDUSTRIES);
  const countries = Object.keys(GEO);
  let made = 0;
  tx(() => {
    for (let i = 0; made < companies && i < companies * 3; i++) {
      const base = pick(r, SYL) + pick(r, SYL) + (r() < 0.4 ? pick(r, SYL) : '');
      const suf = pick(r, SUFFIX);
      const name = (base[0].toUpperCase() + base.slice(1)) + (suf ? (suf.length <= 3 ? suf : ' ' + suf[0].toUpperCase() + suf.slice(1)) : '');
      const domain = slug(base + suf) + '.example';
      const ind = pick(r, industries);
      const meta = INDUSTRIES[ind];
      const desc = pick(r, meta.desc).replace('{aud}', pick(r, AUD)).replace('{task}', pick(r, TASKS)).replace('{prod}', pick(r, PRODS));
      const country = r() < 0.35 ? 'United States' : pick(r, countries);
      const city = pick(r, GEO[country]);
      const sizeBucket = r();
      const employees = sizeBucket < 0.35 ? 2 + Math.floor(r() * 18) : sizeBucket < 0.7 ? 20 + Math.floor(r() * 180) : sizeBucket < 0.92 ? 200 + Math.floor(r() * 1800) : 2000 + Math.floor(r() * 30000);
      const stageIdx = Math.min(STAGES.length - 1, Math.floor(Math.log10(employees + 1) * 2 + r() * 2 - 1));
      const stage = r() < 0.2 ? 'Bootstrapped' : STAGES[Math.max(0, stageIdx)];
      const fundingTotal = stage === 'Bootstrapped' ? 0 : Math.round(Math.pow(10, 5 + STAGES.indexOf(stage) * 0.6 + r()));
      const daysAgo = Math.floor(r() * 900);
      const lastFunding = stage === 'Bootstrapped' ? null : new Date(Date.UTC(2026, 10, 1) - daysAgo * 864e5).toISOString().slice(0, 10);
      const tags = sample(r, meta.tags, 2 + Math.floor(r() * 2));
      if (lastFunding && daysAgo < 180) tags.push('recently funded');
      if (r() < 0.15 && ind !== 'Artificial Intelligence') tags.push('develops AI');
      const model = ['E-commerce'].includes(ind) ? 'B2C' : ['Events & Weddings', 'Edtech', 'Healthtech'].includes(ind) && r() < 0.5 ? 'B2C' : r() < 0.85 ? 'B2B' : 'Marketplace';
      if (['SaaS', 'Artificial Intelligence', 'Cybersecurity', 'HR Tech'].includes(ind) && r() < 0.8) tags.push('subscription');
      const remote = pick(r, ['Remote', 'Hybrid', 'Hybrid', 'Onsite']);
      if (remote === 'Remote') tags.push('remote team');
      const res = insC.run(name, domain, `${name} is a ${desc}.`, ind, JSON.stringify([...new Set(tags)]), JSON.stringify(sample(r, TECH, 3 + Math.floor(r() * 4))), country, city, employees,
        Math.round(employees * (40000 + r() * 160000)), stage, fundingTotal, lastFunding, 1995 + Math.floor(r() * 31), model, remote, Math.floor(r() * Math.min(60, employees / 4)), `https://linkedin.example/company/${slug(base + suf)}`);
      if (!res.changes) continue;
      made++;
      const cid = res.lastInsertRowid;
      const nPeople = 2 + Math.floor(r() * 5);
      const roles = sample(r, ROLES, nPeople);
      for (const [title, seniority, dept] of roles) {
        const fn = pick(r, FIRST), ln = pick(r, LAST);
        const status = r() < 0.82 ? 'verified' : r() < 0.6 ? 'risky' : 'unknown';
        insP.run(cid, fn, ln, title, seniority, dept, `${slug(fn)}.${slug(ln)}@${domain}`, status,
          r() < 0.45 ? `+1 555 01${String(Math.floor(r() * 100)).padStart(2, '0')}` : null,
          `https://linkedin.example/in/${slug(fn)}-${slug(ln)}-${Math.floor(r() * 9999)}`, country, city);
      }
    }
  });
  return { companies: made };
}

module.exports = { seed, INDUSTRIES, GEO, STAGES, TECH };
if (require.main === module) console.log(seed());
