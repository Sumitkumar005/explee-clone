'use strict';
const { db } = require('./db');

const hydrate = (c) => c && ({ ...c, tags: JSON.parse(c.tags || '[]'), technologies: JSON.parse(c.technologies || '[]') });

function buildWhere(f) {
  const w = [], p = [];
  const inList = (col, arr) => { if (arr?.length) { w.push(`${col} IN (${arr.map(() => '?').join(',')})`); p.push(...arr); } };
  inList('industry', f.industries);
  if (f.countries?.length && f.cities?.length) {
    w.push(`(country IN (${f.countries.map(() => '?').join(',')}) OR city IN (${f.cities.map(() => '?').join(',')}))`); p.push(...f.countries, ...f.cities);
  } else { inList('country', f.countries); inList('city', f.cities); }
  inList('funding_stage', f.funding_stages);
  if (f.employees_min != null) { w.push('employees >= ?'); p.push(f.employees_min); }
  if (f.employees_max != null) { w.push('employees <= ?'); p.push(f.employees_max); }
  if (f.recently_funded) { w.push("last_funding_date >= date('2026-11-01', '-180 days')"); }
  if (f.business_model) { w.push('business_model = ?'); p.push(f.business_model); }
  if (f.remote_policy) { w.push('remote_policy = ?'); p.push(f.remote_policy); }
  if (f.technologies?.length) { w.push(`(${f.technologies.map(() => 'technologies LIKE ?').join(' OR ')})`); p.push(...f.technologies.map((t) => `%"${t}"%`)); }
  if (f.revenue_min != null) { w.push('revenue_usd >= ?'); p.push(f.revenue_min); }
  if (f.revenue_max != null) { w.push('revenue_usd <= ?'); p.push(f.revenue_max); }
  if (f.exclude_ids?.length) { w.push(`id NOT IN (${f.exclude_ids.map(() => '?').join(',')})`); p.push(...f.exclude_ids); }
  return { where: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}

// Fit score 0-100: hard filters already matched; keywords and tech overlap drive the rest.
function score(c, f) {
  const hay = `${c.name} ${c.description} ${c.tags.join(' ')} ${c.industry}`.toLowerCase();
  const kws = f.keywords || [];
  const hits = kws.filter((k) => hay.includes(k.toLowerCase().replace(/s$/, '')));
  let s = 60;
  if (kws.length) s += Math.round(35 * hits.length / kws.length);
  else s += 25;
  if (f.technologies?.length) s += Math.min(5, f.technologies.filter((t) => c.technologies.includes(t)).length * 2);
  if (c.tags.includes('recently funded')) s += 2;
  return { score: Math.min(99, s), matched: hits };
}

function searchCompanies(f, { page = 1, pageSize = 25, sort = 'fit' } = {}) {
  const { where, params } = buildWhere(f);
  const rows = db.prepare(`SELECT * FROM companies ${where} LIMIT 20000`).all(...params).map(hydrate);
  let scored = rows.map((c) => { const { score: s, matched } = score(c, f); return { ...c, fit_score: s, matched_keywords: matched }; });
  if (f.keywords?.length && !f.industries?.length) scored = scored.filter((c) => c.matched_keywords.length > 0);
  const sorters = {
    fit: (a, b) => b.fit_score - a.fit_score || b.employees - a.employees,
    employees: (a, b) => b.employees - a.employees,
    funding: (a, b) => (b.funding_total_usd || 0) - (a.funding_total_usd || 0),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  scored.sort(sorters[sort] || sorters.fit);
  const total = scored.length;
  return { total, page, pageSize, results: scored.slice((page - 1) * pageSize, page * pageSize), allIds: scored.map((c) => c.id) };
}

const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); const i = [...A].filter((x) => B.has(x)).length; return A.size + B.size ? i / (A.size + B.size - i) : 0; };

function lookalike(seed, { page = 1, pageSize = 25, countries = [] } = {}) {
  const pool = db.prepare(`SELECT * FROM companies WHERE id != ? ${countries.length ? `AND country IN (${countries.map(() => '?').join(',')})` : ''}`).all(seed.id || -1, ...countries).map(hydrate);
  const scored = pool.map((c) => {
    const sizeSim = 1 - Math.min(1, Math.abs(Math.log10(c.employees + 1) - Math.log10((seed.employees || 50) + 1)) / 2);
    const s = (c.industry === seed.industry ? 40 : 0) + 30 * jaccard(c.tags, seed.tags || []) + 15 * jaccard(c.technologies, seed.technologies || [])
      + 10 * sizeSim + (c.country === seed.country ? 3 : 0) + (c.business_model === seed.business_model ? 2 : 0);
    return { ...c, fit_score: Math.round(Math.min(99, s)) };
  }).filter((c) => c.fit_score >= 35).sort((a, b) => b.fit_score - a.fit_score);
  return { total: scored.length, page, pageSize, results: scored.slice((page - 1) * pageSize, page * pageSize), allIds: scored.map((c) => c.id) };
}

function maskEmail(e) { const [u, d] = e.split('@'); return `${u[0]}${'•'.repeat(Math.max(3, u.length - 2))}${u.slice(-1)}@${d}`; }

function searchPeople(pf, { userId, page = 1, pageSize = 25 } = {}) {
  const w = [], p = [];
  if (pf.company_ids?.length) { w.push(`p.company_id IN (${pf.company_ids.map(() => '?').join(',')})`); p.push(...pf.company_ids); }
  if (pf.titles?.length) { w.push(`(${pf.titles.map(() => 'LOWER(p.title) LIKE ?').join(' OR ')})`); p.push(...pf.titles.map((t) => `%${t.toLowerCase()}%`)); }
  if (pf.seniorities?.length) { w.push(`p.seniority IN (${pf.seniorities.map(() => '?').join(',')})`); p.push(...pf.seniorities); }
  if (pf.departments?.length) { w.push(`p.department IN (${pf.departments.map(() => '?').join(',')})`); p.push(...pf.departments); }
  if (pf.countries?.length) { w.push(`p.country IN (${pf.countries.map(() => '?').join(',')})`); p.push(...pf.countries); }
  if (pf.name) { w.push("LOWER(p.first_name || ' ' || p.last_name) LIKE ?"); p.push(`%${pf.name.toLowerCase()}%`); }
  if (pf.industries?.length) { w.push(`c.industry IN (${pf.industries.map(() => '?').join(',')})`); p.push(...pf.industries); }
  if (pf.verified_only) w.push("p.email_status = 'verified'");
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM people p JOIN companies c ON c.id = p.company_id ${where}`).get(...p).n;
  const rows = db.prepare(`SELECT p.*, c.name company_name, c.domain company_domain, c.industry company_industry, c.employees company_employees,
      (SELECT 1 FROM reveals r WHERE r.user_id = ? AND r.person_id = p.id) revealed
    FROM people p JOIN companies c ON c.id = p.company_id ${where}
    ORDER BY CASE p.seniority WHEN 'Founder' THEN 0 WHEN 'C-Level' THEN 1 WHEN 'VP' THEN 2 WHEN 'Head' THEN 3 WHEN 'Director' THEN 4 WHEN 'Manager' THEN 5 ELSE 6 END, p.id
    LIMIT ? OFFSET ?`).all(userId || 0, ...p, pageSize, (page - 1) * pageSize);
  return { total, page, pageSize, results: rows.map(publicPerson) };
}

function publicPerson(r) {
  const out = { ...r, revealed: Boolean(r.revealed) };
  if (!out.revealed) { out.email = maskEmail(r.email); out.phone = r.phone ? r.phone.replace(/\d(?=\d{0,3}$)/g, '•') : null; }
  return out;
}

module.exports = { searchCompanies, lookalike, searchPeople, publicPerson, hydrate, buildWhere, maskEmail };
