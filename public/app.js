'use strict';
// Leadscope single-page app. No framework: hash router + small render helpers.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n == null ? '–' : Number(n).toLocaleString('en-US');
const money = (n) => n == null ? '–' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`;
const COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#2563eb', '#65a30d'];
const avatar = (name) => `<span class="avatar" style="background:${COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length]}">${esc(name[0] || '?')}</span>`;

const state = { me: null, meta: null, search: null, people: null, look: null };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.blob();
  if (!res.ok) {
    if (res.status === 401) openAuth('signup', data.error);
    else if (res.status === 402) toast(`${data.error} `, { href: '#/billing', label: 'Get credits' });
    else toast(data.error || 'Request failed');
    throw Object.assign(new Error(data.error), { status: res.status });
  }
  return data;
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }

let toastTimer;
function toast(msg, link) {
  const t = $('#toast'); t.hidden = false;
  t.innerHTML = esc(msg) + (link ? ` <a href="${link.href}" style="color:inherit;text-decoration:underline">${esc(link.label)}</a>` : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}
function modal(html, { wide = false } = {}) { const m = $('#modal'); $('#modal-body').className = `modal${wide ? ' wide' : ''}`; $('#modal-body').innerHTML = html; m.hidden = false; return $('#modal-body'); }
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });
function drawer(html) { $('#drawer-body').innerHTML = html; $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeDrawer(); } });
document.addEventListener('click', (e) => { if (e.target.closest('[data-close-drawer]')) closeDrawer(); });

// ---------------------------------------------------------------- account
async function loadMe() { state.me = (await api('GET', '/api/me')).user; renderAccount(); }
function renderAccount() {
  const el = $('#account');
  if (!state.me) { el.innerHTML = `<button class="btn ghost" data-auth="login">Sign in</button><button class="btn primary" data-auth="signup">Sign up free</button>`; }
  else el.innerHTML = `<a class="credits" href="#/billing" title="Credit balance">${fmt(state.me.credits)} credits</a><span class="who muted small">${esc(state.me.email)}</span><button class="btn sm" id="logout">Log out</button>`;
  $$('[data-auth]', el).forEach((b) => b.onclick = () => openAuth(b.dataset.auth));
  const lo = $('#logout'); if (lo) lo.onclick = async () => { await api('POST', '/api/auth/logout'); state.me = null; renderAccount(); location.hash = '#/'; };
}
function openAuth(mode = 'signup', reason) {
  const m = modal(`<h2>${mode === 'signup' ? 'Create your free account' : 'Sign in'}</h2>
    ${reason ? `<p class="muted">${esc(reason)}</p>` : mode === 'signup' ? `<p class="muted">${fmt(state.meta?.plans?.[0]?.monthly_credits || 500)} free credits. No card needed.</p>` : ''}
    <form class="stack" id="authf">
      ${mode === 'signup' ? '<label class="field"><span>Name</span><input type="text" name="name" autocomplete="name"></label>' : ''}
      <label class="field"><span>Work email</span><input type="email" name="email" required autocomplete="email"></label>
      <label class="field"><span>Password</span><input type="password" name="password" required minlength="8" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></label>
      <button class="btn primary" style="width:100%;justify-content:center">${mode === 'signup' ? 'Create account' : 'Sign in'}</button>
      <p class="small muted" style="text-align:center">${mode === 'signup' ? 'Have an account? <a href="#" data-switch="login">Sign in</a>' : 'New here? <a href="#" data-switch="signup">Create an account</a>'}</p>
    </form>`);
  $('[data-switch]', m).onclick = (e) => { e.preventDefault(); openAuth(e.target.dataset.switch); };
  $('#authf').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    await api('POST', `/api/auth/${mode}`, body);
    closeModal(); await loadMe(); toast(mode === 'signup' ? 'Account created. 500 credits added.' : 'Signed in'); route();
  };
  setTimeout(() => $('input', m)?.focus(), 30);
}
const requireAuth = () => { if (!state.me) { openAuth('signup'); return false; } return true; };
const refreshCredits = async () => { if (state.me) { await loadMe(); } };

// ---------------------------------------------------------------- shared renderers
function companyRow(c, { criteria = [], selectable = true, selected = new Set(), highlight = [] } = {}) {
  const hl = new Set(highlight.map((h) => h.toLowerCase()));
  return `<tr class="clickable" data-company="${c.id}">
    ${selectable ? `<td><input type="checkbox" data-sel="${c.id}" ${selected.has(c.id) ? 'checked' : ''} aria-label="Select ${esc(c.name)}"></td>` : ''}
    <td><div class="co">${avatar(c.name)}<div><b>${esc(c.name)}</b><span class="small muted">${esc(c.domain)}</span></div></div></td>
    <td>${c.fit_score != null ? `<div class="fit"><span class="bar"><i style="width:${c.fit_score}%"></i></span><b>${c.fit_score}</b></div>` : ''}</td>
    <td class="desc">${esc(c.description)}<div class="tags">${c.tags.map((t) => `<span class="tag ${[...hl].some((h) => t.toLowerCase().includes(h)) ? 'hl' : ''}">${esc(t)}</span>`).join('')}</div>${c.filter_reason ? `<div class="small muted" style="margin-top:4px">AI: ${esc(c.filter_reason)}</div>` : ''}</td>
    ${criteria.map((_, i) => { const r = c.criteria?.[i]; return `<td class="crit-cell">${r ? `<span class="verdict ${r.verdict}">${r.verdict}</span><span class="small muted">${esc(r.reason)}</span>` : '<span class="muted small">Not checked</span>'}</td>`; }).join('')}
    <td class="nowrap">${esc(c.industry)}</td>
    <td class="nowrap">${esc(c.city)}, ${esc(c.country)}</td>
    <td class="right">${fmt(c.employees)}</td>
    <td class="nowrap">${esc(c.funding_stage)}${c.funding_total_usd ? `<div class="small muted">${money(c.funding_total_usd)}</div>` : ''}</td>
  </tr>`;
}
const companyHead = (criteria = [], selectable = true) => `<tr>${selectable ? '<th><input type="checkbox" data-selall aria-label="Select all"></th>' : ''}<th>Company</th><th>Fit</th><th>Description</th>
  ${criteria.map((c, i) => `<th class="crit" title="${esc(c)}">AI: ${esc(c.length > 28 ? c.slice(0, 28) + '…' : c)}<span class="x" data-delcrit="${i}" title="Remove column">✕</span></th>`).join('')}
  <th>Industry</th><th>Location</th><th class="right">Employees</th><th>Funding</th></tr>`;

function personRow(p, { selected = new Set() } = {}) {
  return `<tr>
    <td><input type="checkbox" data-psel="${p.id}" ${selected.has(p.id) ? 'checked' : ''} aria-label="Select ${esc(p.first_name)}"></td>
    <td><div class="co">${avatar(p.first_name)}<div><b>${esc(p.first_name)} ${esc(p.last_name)}</b><span class="small muted">${esc(p.title)}</span></div></div></td>
    <td><a href="#" data-company-link="${p.company_id}">${esc(p.company_name)}</a><div class="small muted">${esc(p.company_domain)}</div></td>
    <td class="nowrap">${esc(p.email)} <span class="status ${p.email_status}">${esc(p.email_status)}</span></td>
    <td class="nowrap">${p.phone ? esc(p.phone) : '<span class="muted">–</span>'}</td>
    <td class="nowrap">${esc(p.city)}, ${esc(p.country)}</td>
    <td>${p.revealed ? `<a href="${esc(p.linkedin_url)}" target="_blank" rel="noopener">Profile</a>` : `<button class="btn sm" data-reveal="${p.id}">Reveal · 1 credit</button>`}</td>
  </tr>`;
}
const personHead = '<tr><th><input type="checkbox" data-pselall aria-label="Select all"></th><th>Name</th><th>Company</th><th>Email</th><th>Phone</th><th>Location</th><th></th></tr>';

async function openCompany(id) {
  drawer('<div class="empty"><span class="spinner"></span></div>');
  const { company: c, people } = await api('GET', `/api/companies/${id}`);
  drawer(`<div class="row" style="justify-content:space-between"><div class="co">${avatar(c.name)}<div><h2 style="margin:0">${esc(c.name)}</h2><span class="muted">${esc(c.domain)}</span></div></div><button class="btn ghost" data-close-drawer aria-label="Close">✕</button></div>
    <p>${esc(c.description)}</p><div class="tags">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <h3 style="margin-top:20px">Firmographics</h3>
    <dl class="kv"><dt>Industry</dt><dd>${esc(c.industry)}</dd><dt>Business model</dt><dd>${esc(c.business_model)}</dd><dt>HQ</dt><dd>${esc(c.city)}, ${esc(c.country)}</dd>
      <dt>Employees</dt><dd>${fmt(c.employees)}</dd><dt>Est. revenue</dt><dd>${money(c.revenue_usd)}</dd><dt>Funding</dt><dd>${esc(c.funding_stage)}${c.funding_total_usd ? ` · ${money(c.funding_total_usd)} total` : ''}</dd>
      <dt>Last round</dt><dd>${esc(c.last_funding_date || '–')}</dd><dt>Founded</dt><dd>${esc(c.founded_year)}</dd><dt>Work policy</dt><dd>${esc(c.remote_policy)}</dd>
      <dt>Open roles</dt><dd>${fmt(c.hiring_open_roles)}</dd><dt>Tech stack</dt><dd>${c.technologies.map(esc).join(', ')}</dd><dt>LinkedIn</dt><dd><a href="${esc(c.linkedin_url)}" target="_blank" rel="noopener">Company page</a></dd></dl>
    <div class="row" style="justify-content:space-between;margin-top:20px"><h3 style="margin:0">Decision makers (${people.length})</h3>
      <div class="row"><button class="btn sm" id="rev-all">Reveal all</button><button class="btn sm" id="add-co">Save company</button></div></div>
    <div id="dpeople">${people.map((p) => `<div class="person">${avatar(p.first_name)}<div class="grow"><b>${esc(p.first_name)} ${esc(p.last_name)}</b> <span class="muted">· ${esc(p.title)}</span>
      <div class="small">${esc(p.email)} <span class="status ${p.email_status}">${esc(p.email_status)}</span>${p.phone ? ` · ${esc(p.phone)}` : ''}</div></div>
      ${p.revealed ? `<a class="small" href="${esc(p.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>` : `<button class="btn sm" data-reveal="${p.id}">Reveal</button>`}</div>`).join('') || '<p class="muted">No contacts on file.</p>'}</div>`);
  const body = $('#drawer-body');
  $$('[data-reveal]', body).forEach((b) => b.onclick = async () => { if (!requireAuth()) return; await api('POST', '/api/people/reveal', { ids: [+b.dataset.reveal] }); await refreshCredits(); openCompany(id); });
  $('#rev-all').onclick = async () => { if (!requireAuth()) return; const r = await api('POST', '/api/people/reveal', { ids: people.map((p) => p.id) }); toast(`Revealed ${people.length} contacts · ${r.charged} credits`); await refreshCredits(); openCompany(id); };
  $('#add-co').onclick = () => saveToList('companies', [c.id]);
}

async function saveToList(kind, ids) {
  if (!requireAuth()) return;
  if (!ids.length) return toast('Select rows first');
  const lists = (await api('GET', '/api/lists')).filter((l) => l.kind === kind);
  const m = modal(`<h2>Save ${ids.length} ${kind === 'companies' ? (ids.length === 1 ? 'company' : 'companies') : (ids.length === 1 ? 'contact' : 'contacts')}</h2>
    <div class="stack">${lists.map((l) => `<button class="btn" style="width:100%;justify-content:space-between" data-list="${l.id}">${esc(l.name)} <span class="muted">${l.items}</span></button>`).join('')}
    <form id="newl" class="row"><input type="text" name="name" placeholder="New list name" required class="grow" style="flex:1"><button class="btn primary">Create &amp; save</button></form></div>`);
  const add = async (lid) => { const r = await api('POST', `/api/lists/${lid}/items`, { ids }); closeModal(); toast(`Added ${r.added} to list`); };
  $$('[data-list]', m).forEach((b) => b.onclick = () => add(b.dataset.list));
  $('#newl').onsubmit = async (e) => { e.preventDefault(); const l = await api('POST', '/api/lists', { name: new FormData(e.target).get('name'), kind }); add(l.id); };
}

// ---------------------------------------------------------------- Companies search
const EXAMPLES = ['Fintech startups in the UK under 50 employees', 'TikTok growth agencies for e-commerce brands', 'Recently funded AI companies in Berlin', 'Remote-first SaaS companies using Stripe', 'Wedding planners and floral studios in the United Kingdom', 'Study abroad edtech companies in India'];

function viewSearch() {
  const s = state.search;
  if (s && !s.results) { $('#app').innerHTML = '<div class="empty"><span class="spinner"></span></div>'; return; }
  if (!s) {
    $('#app').innerHTML = `<section class="hero"><h1>Find the companies that will buy from you</h1>
      <p>Describe your ideal customer in plain English. Get ranked companies, the decision makers inside them and verified emails.</p>
      <form class="searchbox" id="sf"><input type="text" name="q" placeholder="e.g. SaaS startups with remote teams using AI" autocomplete="off" required><button class="btn primary">Search</button></form>
      <div class="examples">${EXAMPLES.map((e) => `<span class="chip" data-ex="${esc(e)}">${esc(e)}</span>`).join('')}</div>
      <div class="stats-line">${fmt(state.meta.stats.companies)} companies · ${fmt(state.meta.stats.people)} decision makers · ${state.meta.ai.enabled ? `AI by ${esc(state.meta.ai.model)}` : 'AI in offline mode'} · no sign-up needed to search</div></section>`;
    $('#sf').onsubmit = (e) => { e.preventDefault(); runSearch({ query: new FormData(e.target).get('q') }); };
    $$('[data-ex]').forEach((c) => c.onclick = () => runSearch({ query: c.dataset.ex }));
    setTimeout(() => $('#sf input').focus(), 30);
    return;
  }
  const f = s.filters;
  $('#app').innerHTML = `<form class="searchbox" id="sf" style="max-width:none;margin-bottom:16px"><input type="text" name="q" value="${esc(s.query)}" required><button class="btn primary">Search</button></form>
    <div class="layout">${filterSidebar(f)}
    <section class="panel">
      <div class="toolbar">
        <b>${fmt(s.total)}</b><span class="muted">companies${s.kept != null ? ` · prompt filter kept ${s.kept} of ${s.checked}` : ''}</span>
        <span class="grow"></span>
        <select id="sort" style="width:auto"><option value="fit">Sort: best fit</option><option value="employees">Sort: employees</option><option value="funding">Sort: funding</option><option value="name">Sort: name</option></select>
        <button class="btn" id="addcrit" title="Add a yes/no question answered by AI for every row">+ AI column</button>
        <button class="btn" id="pfilter" title="Let AI keep only companies matching a description">Prompt filter</button>
        <button class="btn" id="contacts">Find contacts</button>
        <button class="btn" id="save">Save to list</button>
        <button class="btn" id="export">Export CSV</button>
      </div>
      <div class="table-wrap"><table><thead>${companyHead(s.criteria)}</thead><tbody>${s.results.map((c) => companyRow(c, { criteria: s.criteria, selected: s.selected, highlight: f.keywords || [] })).join('') || `<tr><td colspan="9" class="empty">No matches. Loosen a filter on the left.</td></tr>`}</tbody></table></div>
      ${s.kept == null ? pager(s) : `<div class="pager"><button class="btn sm" id="clearpf">Clear prompt filter</button></div>`}
    </section></div>`;
  $('#sf').onsubmit = (e) => { e.preventDefault(); runSearch({ query: new FormData(e.target).get('q') }); };
  $('#sort').value = s.sort || 'fit';
  $('#sort').onchange = (e) => { s.sort = e.target.value; runSearch({ page: 1 }); };
  bindFilterSidebar((nf) => runSearch({ filters: nf, page: 1 }));
  bindCompanyTable(s);
  bindPager(s, (p) => runSearch({ page: p }));
  $('#addcrit').onclick = () => addCriterion();
  $('#pfilter').onclick = () => promptFilter();
  $('#contacts').onclick = () => { const ids = s.selected.size ? [...s.selected] : s.results.map((c) => c.id); state.people = { filters: { company_ids: ids }, page: 1, selected: new Set(), label: `${ids.length} companies from your search` }; location.hash = '#/people'; };
  $('#save').onclick = () => saveToList('companies', [...s.selected]);
  $('#export').onclick = async () => { if (!requireAuth()) return; const ids = s.selected.size ? [...s.selected] : s.results.map((c) => c.id); download(await api('POST', '/api/export/companies', { ids, search_id: s.search_id }), 'companies.csv'); };
  const cp = $('#clearpf'); if (cp) cp.onclick = () => runSearch({ page: 1 });
  $$('[data-delcrit]').forEach((x) => x.onclick = async (e) => { e.stopPropagation(); const r = await api('DELETE', `/api/searches/${s.search_id}/criteria/${x.dataset.delcrit}`); s.criteria = r.criteria; runSearch({ page: s.page }); });
}

function filterSidebar(f) {
  const m = state.meta;
  const checks = (name, opts, vals) => `<div class="checks">${opts.map((o) => `<label><input type="checkbox" name="${name}" value="${esc(o)}" ${vals?.includes(o) ? 'checked' : ''}>${esc(o)}</label>`).join('')}</div>`;
  return `<aside class="panel sidebar" id="filters"><button type="button" class="btn sm only-mobile" onclick="this.parentElement.classList.toggle('expanded')" style="margin:12px 14px 0">Show / hide filters</button>
    <div class="group"><h4>Parsed from your query</h4><div class="row">${chips(f).join('') || '<span class="muted small">No structured filters</span>'}</div></div>
    <div class="group"><h4>Keywords</h4><input type="text" name="keywords" value="${esc((f.keywords || []).join(', '))}" placeholder="tiktok, subscription"></div>
    <div class="group"><h4>Industry</h4>${checks('industries', m.industries, f.industries)}</div>
    <div class="group"><h4>Country</h4>${checks('countries', m.countries, f.countries)}</div>
    <div class="group"><h4>Employees</h4><div class="row"><input type="number" name="employees_min" placeholder="Min" value="${f.employees_min ?? ''}" style="width:47%"><input type="number" name="employees_max" placeholder="Max" value="${f.employees_max ?? ''}" style="width:47%"></div></div>
    <div class="group"><h4>Funding stage</h4>${checks('funding_stages', m.stages, f.funding_stages)}<label class="small" style="display:flex;gap:6px;margin-top:8px"><input type="checkbox" name="recently_funded" ${f.recently_funded ? 'checked' : ''}>Raised in last 6 months</label></div>
    <div class="group"><h4>Business model</h4><select name="business_model"><option value="">Any</option>${['B2B', 'B2C', 'Marketplace'].map((o) => `<option ${f.business_model === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
    <div class="group"><h4>Work policy</h4><select name="remote_policy"><option value="">Any</option>${['Remote', 'Hybrid', 'Onsite'].map((o) => `<option ${f.remote_policy === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
    <div class="group"><h4>Technologies</h4>${checks('technologies', m.technologies, f.technologies)}</div>
    <div class="group"><button class="btn primary" id="applyf" style="width:100%;justify-content:center">Apply filters</button></div>
  </aside>`;
}
function chips(f) {
  const c = [];
  (f.industries || []).forEach((v) => c.push(v)); (f.countries || []).forEach((v) => c.push(v)); (f.cities || []).forEach((v) => c.push(v));
  if (f.employees_min != null || f.employees_max != null) c.push(`${f.employees_min ?? 0}–${f.employees_max ?? '∞'} employees`);
  (f.funding_stages || []).forEach((v) => c.push(v)); if (f.recently_funded) c.push('Recently funded');
  if (f.business_model) c.push(f.business_model); if (f.remote_policy) c.push(f.remote_policy);
  (f.technologies || []).forEach((v) => c.push(`Uses ${v}`));
  return c.map((v) => `<span class="chip brand">${esc(v)}</span>`);
}
function bindFilterSidebar(onApply) {
  $('#applyf').onclick = () => {
    const el = $('#filters'); const vals = (n) => $$(`input[name=${n}]:checked`, el).map((i) => i.value); const num = (n) => { const v = $(`[name=${n}]`, el).value; return v === '' ? null : +v; };
    onApply({ ...state.search?.filters, industries: vals('industries'), countries: vals('countries'), funding_stages: vals('funding_stages'), technologies: vals('technologies'),
      employees_min: num('employees_min'), employees_max: num('employees_max'), recently_funded: $('[name=recently_funded]', el).checked,
      business_model: $('[name=business_model]', el).value || null, remote_policy: $('[name=remote_policy]', el).value || null,
      keywords: $('[name=keywords]', el).value.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean) });
  };
}
function bindCompanyTable(s) {
  $$('tr[data-company]').forEach((tr) => tr.onclick = (e) => { if (e.target.closest('input')) return; openCompany(tr.dataset.company); });
  $$('[data-sel]').forEach((cb) => cb.onchange = () => { cb.checked ? s.selected.add(+cb.dataset.sel) : s.selected.delete(+cb.dataset.sel); });
  const all = $('[data-selall]'); if (all) all.onchange = () => { $$('[data-sel]').forEach((cb) => { cb.checked = all.checked; all.checked ? s.selected.add(+cb.dataset.sel) : s.selected.delete(+cb.dataset.sel); }); };
}
const pager = (s) => { const pages = Math.max(1, Math.ceil(s.total / s.page_size)); return `<div class="pager"><span class="muted small">Page ${s.page} of ${fmt(pages)}</span><div class="row"><button class="btn sm" data-pg="${s.page - 1}" ${s.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn sm" data-pg="${s.page + 1}" ${s.page >= pages ? 'disabled' : ''}>Next</button></div></div>`; };
const bindPager = (s, go) => $$('[data-pg]').forEach((b) => b.onclick = () => { if (+b.dataset.pg > 1 && !state.me) return openAuth('signup', 'Sign up free to see every result.'); go(+b.dataset.pg); });

async function runSearch({ query, filters, page = 1 } = {}) {
  const prev = state.search;
  const fresh = query != null && query !== prev?.query;
  const body = { page, sort: prev?.sort, ...(fresh ? { query } : { search_id: prev?.search_id, filters: filters || prev?.filters, query: prev?.query }) };
  if (location.hash !== '#/' && location.hash !== '') location.hash = '#/';
  $('#app').innerHTML = `<div class="empty"><span class="spinner"></span> ${fresh ? 'Reading your query and ranking companies…' : 'Updating…'}</div>`;
  try {
    const r = await api('POST', '/api/search/companies', body);
    state.search = { ...r, query: fresh ? query : prev.query, sort: prev?.sort, selected: fresh ? new Set() : prev?.selected || new Set() };
    if (state.me && r.criteria.length && r.results.some((c) => Object.keys(c.criteria || {}).length < r.criteria.length)) {
      const fill = await api('POST', `/api/searches/${r.search_id}/criteria/fill`, { company_ids: r.results.map((c) => c.id) });
      const map = new Map(fill.results.map((x) => [x.id, x.criteria])); state.search.results.forEach((c) => { c.criteria = map.get(c.id) || c.criteria; });
      if (fill.charged) { toast(`AI columns filled for new rows · ${fill.charged} credits`); refreshCredits(); }
    }
  } catch (e) { if (!prev) state.search = null; }
  viewSearch();
}

function addCriterion() {
  if (!requireAuth()) return;
  const s = state.search; const plan = state.me.plan_info;
  const m = modal(`<h2>Add an AI column</h2><p class="muted">Ask a yes/no question. AI answers it for each of the ${s.results.length} companies on this page with a short reason. Costs ${s.results.length} credits.</p>
    <form id="cf" class="stack"><input type="text" name="c" required placeholder="e.g. Do they sell on a subscription model?">
    <div class="examples" style="justify-content:flex-start">${['Is it an AI startup with a subscription model?', 'Do they sell to e-commerce brands?', 'Are they hiring for sales roles?', 'Do they have a remote team?'].map((e) => `<span class="chip" data-ex="${esc(e)}">${esc(e)}</span>`).join('')}</div>
    <p class="small muted">${esc(plan.name)} plan: ${plan.ai_criteria_per_search} AI column${plan.ai_criteria_per_search > 1 ? 's' : ''} per search · ${s.criteria.length} used</p>
    <div class="row"><span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Run on ${s.results.length} rows</button></div></form>`);
  $$('[data-ex]', m).forEach((c) => c.onclick = () => { $('[name=c]', m).value = c.dataset.ex; });
  $('#cf').onsubmit = async (e) => {
    e.preventDefault(); const btn = $('button.primary', m); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Researching…';
    try {
      const r = await api('POST', `/api/searches/${s.search_id}/criteria`, { criterion: new FormData(e.target).get('c'), company_ids: s.results.map((c) => c.id) });
      s.criteria = r.criteria; const map = new Map(r.results.map((x) => [x.id, x.criteria])); s.results.forEach((c) => { c.criteria = { ...c.criteria, ...map.get(c.id) }; });
      closeModal(); toast(`AI column added · ${r.charged} credits`); refreshCredits(); viewSearch();
    } catch { btn.disabled = false; btn.textContent = 'Try again'; }
  };
}
function promptFilter() {
  if (!requireAuth()) return;
  const s = state.search;
  const m = modal(`<h2>Prompt filter</h2><p class="muted">Describe exactly what you want. AI reads the top 50 matches and keeps only the ones that fit. Costs 50 credits.</p>
    <form id="pf" class="stack"><textarea name="p" required style="min-height:80px" placeholder="e.g. agencies specialising in TikTok growth for e-commerce brands"></textarea>
    <div class="row"><span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Filter</button></div></form>`);
  $('#pf').onsubmit = async (e) => {
    e.preventDefault(); const btn = $('button.primary', m); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Checking 50 companies…';
    try { const r = await api('POST', `/api/searches/${s.search_id}/prompt-filter`, { prompt: new FormData(e.target).get('p'), limit: 50 }); Object.assign(s, { results: r.results, kept: r.kept, checked: r.checked }); closeModal(); refreshCredits(); viewSearch(); }
    catch { btn.disabled = false; btn.textContent = 'Try again'; }
  };
}

// ---------------------------------------------------------------- People search
async function viewPeople() {
  const p = state.people || (state.people = { filters: { verified_only: false }, page: 1, selected: new Set() });
  const m = state.meta; const f = p.filters;
  const checks = (name, opts) => `<div class="checks">${opts.map((o) => `<label><input type="checkbox" name="${name}" value="${esc(o)}" ${f[name]?.includes(o) ? 'checked' : ''}>${esc(o)}</label>`).join('')}</div>`;
  $('#app').innerHTML = `<div class="layout"><aside class="panel sidebar" id="pf"><button type="button" class="btn sm only-mobile" onclick="this.parentElement.classList.toggle('expanded')" style="margin:12px 14px 0">Show / hide filters</button>
      ${f.company_ids?.length ? `<div class="group"><span class="chip brand">${esc(p.label || `${f.company_ids.length} companies`)} <span class="x" id="clearco">✕</span></span></div>` : ''}
      <div class="group"><h4>Name</h4><input type="text" name="name" value="${esc(f.name || '')}"></div>
      <div class="group"><h4>Job title contains</h4><input type="text" name="titles" value="${esc((f.titles || []).join(', '))}" placeholder="founder, head of growth"></div>
      <div class="group"><h4>Seniority</h4>${checks('seniorities', m.seniorities)}</div>
      <div class="group"><h4>Department</h4>${checks('departments', m.departments)}</div>
      <div class="group"><h4>Company industry</h4>${checks('industries', m.industries)}</div>
      <div class="group"><h4>Country</h4>${checks('countries', m.countries)}</div>
      <div class="group"><label class="small" style="display:flex;gap:6px"><input type="checkbox" name="verified_only" ${f.verified_only ? 'checked' : ''}>Verified emails only</label></div>
      <div class="group"><button class="btn primary" id="applyp" style="width:100%;justify-content:center">Search people</button></div></aside>
    <section class="panel"><div class="toolbar"><b id="ptotal">…</b><span class="muted">decision makers</span><span class="grow"></span>
      <button class="btn" id="prev">Reveal selected</button><button class="btn" id="psave">Save to list</button><button class="btn" id="pexp">Export CSV</button></div>
      <div id="ptable"><div class="empty"><span class="spinner"></span></div></div></section></div>`;
  const cc = $('#clearco'); if (cc) cc.onclick = () => { delete f.company_ids; viewPeople(); };
  $('#applyp').onclick = () => {
    const el = $('#pf'); const vals = (n) => $$(`input[name=${n}]:checked`, el).map((i) => i.value);
    p.filters = { company_ids: f.company_ids, name: $('[name=name]', el).value.trim() || undefined, titles: $('[name=titles]', el).value.split(',').map((t) => t.trim()).filter(Boolean),
      seniorities: vals('seniorities'), departments: vals('departments'), industries: vals('industries'), countries: vals('countries'), verified_only: $('[name=verified_only]', el).checked };
    p.page = 1; viewPeople();
  };
  const r = await api('POST', '/api/people/search', { filters: p.filters, page: p.page }).catch(() => null);
  if (!r) return;
  p.total = r.total; p.page_size = r.pageSize; p.results = r.results;
  $('#ptotal').textContent = fmt(r.total);
  $('#ptable').innerHTML = `<div class="table-wrap"><table><thead>${personHead}</thead><tbody>${r.results.map((x) => personRow(x, { selected: p.selected })).join('') || '<tr><td colspan="7" class="empty">No people match.</td></tr>'}</tbody></table></div>${pager(p)}`;
  bindPeopleTable(p, () => viewPeople());
  bindPager(p, (pg) => { p.page = pg; viewPeople(); });
  $('#prev').onclick = async () => { if (!requireAuth()) return; if (!p.selected.size) return toast('Select contacts first'); const x = await api('POST', '/api/people/reveal', { ids: [...p.selected] }); toast(`Revealed · ${x.charged} credits`); refreshCredits(); viewPeople(); };
  $('#psave').onclick = () => saveToList('people', [...p.selected]);
  $('#pexp').onclick = async () => { if (!requireAuth()) return; const ids = p.selected.size ? [...p.selected] : p.results.map((x) => x.id); download(await api('POST', '/api/export/people', { ids }), 'contacts.csv'); toast('Only revealed contacts export with full emails'); };
}
function bindPeopleTable(p, rerender) {
  $$('[data-psel]').forEach((cb) => cb.onchange = () => { cb.checked ? p.selected.add(+cb.dataset.psel) : p.selected.delete(+cb.dataset.psel); });
  const all = $('[data-pselall]'); if (all) all.onchange = () => $$('[data-psel]').forEach((cb) => { cb.checked = all.checked; all.checked ? p.selected.add(+cb.dataset.psel) : p.selected.delete(+cb.dataset.psel); });
  $$('[data-reveal]').forEach((b) => b.onclick = async () => { if (!requireAuth()) return; await api('POST', '/api/people/reveal', { ids: [+b.dataset.reveal] }); refreshCredits(); rerender(); });
  $$('[data-company-link]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openCompany(a.dataset.companyLink); });
}

// ---------------------------------------------------------------- Lookalike
function viewLookalike() {
  const l = state.look;
  $('#app').innerHTML = `<section class="hero" style="padding-top:24px"><h1>Find lookalike companies</h1><p>Enter your best customer's domain. We match industry, positioning, tech stack and size.</p>
    <form class="searchbox" id="lf"><input type="text" name="d" placeholder="e.g. a customer domain from your search results" value="${esc(l?.domain || '')}" required><button class="btn primary">Find lookalikes</button></form>
    <p class="small muted" style="margin-top:10px">Tip: open any company in search and copy its domain here.</p></section><div id="lres"></div>`;
  $('#lf').onsubmit = async (e) => { e.preventDefault(); state.look = { domain: new FormData(e.target).get('d').trim(), page: 1, selected: new Set() }; loadLook(); };
  if (l?.results) renderLook();
}
async function loadLook() {
  const l = state.look; $('#lres').innerHTML = '<div class="empty"><span class="spinner"></span> Profiling and matching…</div>';
  try { Object.assign(l, await api('POST', '/api/search/lookalike', { domain: l.domain, page: l.page })); renderLook(); } catch { $('#lres').innerHTML = ''; }
}
function renderLook() {
  const l = state.look;
  $('#lres').innerHTML = `<section class="panel"><div class="toolbar"><span>Similar to <b>${esc(l.seed.name)}</b> <span class="muted">(${esc(l.seed.industry || 'inferred profile')})</span> · ${fmt(l.total)} matches</span><span class="grow"></span>
    <button class="btn" id="lsave">Save to list</button><button class="btn" id="lcon">Find contacts</button></div>
    <div class="table-wrap"><table><thead>${companyHead([])}</thead><tbody>${l.results.map((c) => companyRow(c, { selected: l.selected })).join('')}</tbody></table></div>${pager(l)}</section>`;
  bindCompanyTable(l); bindPager(l, (pg) => { l.page = pg; loadLook(); });
  $('#lsave').onclick = () => saveToList('companies', [...l.selected]);
  $('#lcon').onclick = () => { const ids = l.selected.size ? [...l.selected] : l.results.map((c) => c.id); state.people = { filters: { company_ids: ids }, page: 1, selected: new Set(), label: `${ids.length} lookalikes of ${l.seed.name}` }; location.hash = '#/people'; };
}

// ---------------------------------------------------------------- Lists & history
async function viewLists(id) {
  if (!state.me) { $('#app').innerHTML = `<div class="empty"><h2>Lists</h2><p>Save companies and contacts into lists, then export them.</p><button class="btn primary" data-auth-open>Sign up free</button></div>`; $('[data-auth-open]').onclick = () => openAuth(); return; }
  if (!id) {
    const lists = await api('GET', '/api/lists');
    $('#app').innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:16px"><h2>Lists</h2><button class="btn primary" id="nl">New list</button></div>
      <div class="grid g3">${lists.map((l) => `<a class="panel card" href="#/lists/${l.id}" style="color:inherit"><h3>${esc(l.name)} <span class="status">${esc(l.kind)}</span></h3><span class="muted">${fmt(l.items)} items · created ${esc(l.created_at.slice(0, 10))}</span></a>`).join('') || '<p class="muted">No lists yet. Select rows in a search and choose "Save to list".</p>'}</div>`;
    $('#nl').onclick = () => { const m = modal(`<h2>New list</h2><form id="f" class="stack"><input type="text" name="name" required placeholder="List name"><select name="kind"><option value="companies">Companies</option><option value="people">People</option></select><button class="btn primary">Create</button></form>`); $('#f', m).onsubmit = async (e) => { e.preventDefault(); await api('POST', '/api/lists', Object.fromEntries(new FormData(e.target))); closeModal(); viewLists(); }; };
    return;
  }
  const l = await api('GET', `/api/lists/${id}`);
  const sel = new Set();
  $('#app').innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:16px"><div><a href="#/lists" class="small">← Lists</a><h2>${esc(l.name)}</h2></div>
    <div class="row"><a class="btn" href="/api/lists/${l.id}/export.csv">Export CSV</a>${l.kind === 'companies' ? '<button class="btn" id="lc">Find contacts</button>' : '<button class="btn" id="lr">Reveal all</button>'}<button class="btn danger" id="ld">Delete list</button></div></div>
    <section class="panel"><div class="table-wrap"><table><thead>${l.kind === 'companies' ? companyHead([], true) : personHead}</thead><tbody>${l.items.map((x) => l.kind === 'companies' ? companyRow(x) : personRow(x)).join('') || '<tr><td colspan="9" class="empty">Empty list</td></tr>'}</tbody></table></div></section>`;
  if (l.kind === 'companies') { bindCompanyTable({ selected: sel }); $('#lc').onclick = () => { state.people = { filters: { company_ids: l.items.map((c) => c.id) }, page: 1, selected: new Set(), label: `List: ${l.name}` }; location.hash = '#/people'; }; }
  else { bindPeopleTable({ selected: sel }, () => viewLists(id)); $('#lr').onclick = async () => { const r = await api('POST', '/api/people/reveal', { ids: l.items.map((p) => p.id) }); toast(`Revealed · ${r.charged} credits`); refreshCredits(); viewLists(id); }; }
  $('#ld').onclick = async () => { if (confirm(`Delete "${l.name}"?`)) { await api('DELETE', `/api/lists/${l.id}`); location.hash = '#/lists'; } };
}
async function viewHistory() {
  if (!state.me) { $('#app').innerHTML = '<div class="empty">Sign in to see your saved searches.</div>'; return; }
  const rows = await api('GET', '/api/searches');
  $('#app').innerHTML = `<h2>Search history</h2><section class="panel"><div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Query</th><th>AI columns</th><th class="right">Results</th><th></th></tr></thead><tbody>
    ${rows.map((s) => `<tr><td class="nowrap">${esc(s.created_at)}</td><td><span class="status">${esc(s.kind)}</span></td><td>${esc(s.query)}</td><td>${s.criteria.map((c) => `<span class="tag">${esc(c)}</span>`).join(' ')}</td><td class="right">${fmt(s.result_count)}</td><td>${s.kind === 'companies' ? `<button class="btn sm" data-open="${s.id}">Open</button>` : `<button class="btn sm" data-look="${esc(s.query)}">Open</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No searches yet</td></tr>'}
  </tbody></table></div></section>`;
  $$('[data-open]').forEach((b) => b.onclick = () => { const s = rows.find((x) => x.id === +b.dataset.open); state.search = { search_id: s.id, query: s.query, filters: s.filters, criteria: s.criteria, selected: new Set() }; runSearch({ page: 1 }); });
  $$('[data-look]').forEach((b) => b.onclick = () => { state.look = { domain: b.dataset.look, page: 1, selected: new Set() }; location.hash = '#/lookalike'; setTimeout(loadLook, 0); });
}

// ---------------------------------------------------------------- Billing
async function viewBilling() {
  if (!state.me) return openAuth('signup');
  const b = await api('GET', '/api/billing');
  const costLabels = { reveal_email: 'Reveal a contact (email + phone)', ai_criterion_row: 'AI column, per company', prompt_filter_row: 'Prompt filter, per company checked', gtm_email: 'AutoGTM email sent' };
  $('#app').innerHTML = `<h2>Billing and credits</h2>${b.test_mode ? '<p class="notice">Test mode: purchases apply instantly without payment. Add STRIPE_SECRET_KEY to take real payments.</p>' : ''}
    <div class="grid g4" style="margin:16px 0"><div class="panel stat"><b>${fmt(b.balance)}</b><span>credits available</span></div><div class="panel stat"><b>${esc(b.plan.name)}</b><span>current plan</span></div>
      <div class="panel stat"><b>${b.plan.ai_criteria_per_search}</b><span>AI columns per search</span></div><div class="panel stat"><b>Free</b><span>company search, always</span></div></div>
    <h3>Plans</h3><div class="grid g4">${b.plans.map((p) => `<div class="panel card plan ${p.id === b.plan.id ? 'current' : ''}"><h3>${esc(p.name)}</h3><div class="price">$${p.price_usd}<span class="small muted">/mo</span></div><ul>${p.features.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${p.id === b.plan.id ? '<span class="status running">Current plan</span>' : `<button class="btn ${p.price_usd ? 'primary' : ''}" data-plan="${p.id}">${p.price_usd > b.plan.price_usd ? 'Upgrade' : 'Switch'}</button>`}</div>`).join('')}</div>
    <h3 style="margin-top:24px">Top up</h3><div class="row">${b.topups.map((t) => `<button class="btn" data-topup="${t.id}">${fmt(t.credits)} credits · $${t.price_usd}</button>`).join('')}</div>
    <div class="grid g2" style="margin-top:24px"><section class="panel"><div class="toolbar"><b>What costs credits</b></div><table><tbody>${Object.entries(b.costs).map(([k, v]) => `<tr><td>${esc(costLabels[k] || k)}</td><td class="right">${v} credit${v > 1 ? 's' : ''}</td></tr>`).join('')}<tr><td>Company and people search, lookalikes, lists</td><td class="right">Free</td></tr></tbody></table></section>
    <section class="panel"><div class="toolbar"><b>Credit history</b></div><div class="table-wrap" style="max-height:360px"><table><tbody>${b.ledger.map((l) => `<tr><td class="small nowrap">${esc(l.created_at)}</td><td>${esc(l.reason.replace(/_/g, ' '))}</td><td class="right ${l.delta > 0 ? '' : 'muted'}">${l.delta > 0 ? '+' : ''}${fmt(l.delta)}</td><td class="right small muted">${fmt(l.balance_after)}</td></tr>`).join('')}</tbody></table></div></section></div>`;
  $$('[data-plan]').forEach((x) => x.onclick = async () => { await api('POST', '/api/billing/checkout', { plan: x.dataset.plan }); toast('Plan updated'); await loadMe(); viewBilling(); });
  $$('[data-topup]').forEach((x) => x.onclick = async () => { await api('POST', '/api/billing/checkout', { topup: x.dataset.topup }); toast('Credits added'); await loadMe(); viewBilling(); });
}

// ---------------------------------------------------------------- AutoGTM
let gtmPoll = null;
async function viewGtm(id, tab = 'overview') {
  clearInterval(gtmPoll);
  if (!state.me) {
    $('#app').innerHTML = `<section class="hero"><h1>AutoGTM: an outbound agent that books meetings</h1><p>Give it your website. It works out who buys from you, finds them, writes a personal email to each, sends from warmed inboxes and handles the replies. You approve every email before it goes out.</p>
      <div class="steps" style="justify-content:center">${['Analyse your site', 'Pick buyer segments', 'Find prospects', 'Draft emails', 'You approve', 'Send and reply'].map((s) => `<span>${s}</span>`).join('')}</div>
      <button class="btn primary" data-auth-open>Start free</button></section>`;
    $('[data-auth-open]').onclick = () => openAuth(); return;
  }
  if (!id) {
    const cs = await api('GET', '/api/gtm/campaigns');
    $('#app').innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:16px"><div><h2>AutoGTM campaigns</h2><p class="muted" style="margin:0">Pay as you go: ${state.meta.costs.gtm_email} credits (about $0.03) per email sent. Nothing sends until you approve it.</p></div><button class="btn primary" id="newc">New campaign</button></div>
      <div class="grid g3">${cs.map((c) => `<a class="panel card" href="#/autogtm/${c.id}" style="color:inherit"><h3>${esc(new URL(c.website).hostname)} <span class="status ${c.status}">${esc(c.status)}</span></h3>
        <p class="muted small">${esc(c.product_summary)}</p><div class="row small"><span>${fmt(c.sent)} sent</span>·<span>${fmt(c.leads)} leads</span>·<span>${fmt(c.funnel.meeting || 0)} meetings</span>·<span>$${c.spent_usd.toFixed(2)} spent</span></div></a>`).join('') || '<div class="panel empty" style="grid-column:1/-1">No campaigns yet. Start one with your website.</div>'}</div>`;
    $('#newc').onclick = newCampaign;
    return;
  }
  const c = await api('GET', `/api/gtm/campaigns/${id}`);
  refreshCredits();
  const pendingN = c.funnel.pending_approval || 0;
  $('#app').innerHTML = `<a href="#/autogtm" class="small">← Campaigns</a>
    <div class="row" style="justify-content:space-between;margin:4px 0 12px"><div><h2 style="margin:0">${esc(new URL(c.website).hostname)} <span class="status ${c.status}">${esc(c.status)}</span></h2><span class="muted">${esc(c.product_summary)}</span></div>
      <div class="row">${c.status === 'running' ? '<button class="btn" id="pause">Pause</button>' : '<button class="btn primary" id="run">Start sending</button>'}</div></div>
    <div class="grid g4" style="margin-bottom:16px">${[['Emails sent', fmt(c.sent)], ['Leads (hot + warm)', fmt(c.leads)], ['Meetings', fmt(c.funnel.meeting || 0)], ['Spent / budget', `$${c.spent_usd.toFixed(2)} / $${c.budget_usd}`]].map(([k, v]) => `<div class="panel stat"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
    <div class="tabs">${[['overview', 'Segments'], ['approve', `Approval queue${pendingN ? ` (${pendingN})` : ''}`], ['inbox', 'Inbox'], ['prospects', 'All prospects'], ['settings', 'Settings']].map(([k, v]) => `<button data-tab="${k}" class="${tab === k ? 'active' : ''}">${v}</button>`).join('')}</div>
    <div id="gtab"></div>`;
  $$('[data-tab]').forEach((b) => b.onclick = () => viewGtm(id, b.dataset.tab));
  const run = $('#run'); if (run) run.onclick = async () => { await api('PATCH', `/api/gtm/campaigns/${id}`, { status: 'running' }); toast('Campaign running. Approved emails will start sending.'); viewGtm(id, tab); };
  const pause = $('#pause'); if (pause) pause.onclick = async () => { await api('PATCH', `/api/gtm/campaigns/${id}`, { status: 'paused' }); viewGtm(id, tab); };
  const el = $('#gtab');

  if (tab === 'overview') {
    el.innerHTML = `<div class="grid g2">${c.segments.map((s) => `<div class="panel card"><h3><span>${esc(s.name)}</span><span class="status ${s.status}">${esc(s.status)}</span></h3>
      <div class="fit" style="margin-bottom:8px"><span class="bar" style="width:120px"><i style="width:${s.fit_score}%"></i></span><b>${s.fit_score}% fit</b></div>
      <p class="muted small">${esc(s.rationale)}</p><p class="small"><b>Search:</b> ${esc(s.search_query)}<br><b>Titles:</b> ${s.target_titles.map(esc).join(', ')}</p>
      <div class="row small muted"><span>${s.metrics.prospects} prospects</span>·<span>${s.metrics.sent} sent</span>·<span>${s.metrics.leads} leads</span>·<span>${s.metrics.cost_per_lead_usd != null ? `$${s.metrics.cost_per_lead_usd}/lead` : 'no leads yet'}</span></div>
      <div class="row" style="margin-top:10px">${s.status === 'proposed' ? `<button class="btn primary sm" data-act="${s.id}">Find prospects &amp; draft emails</button>` : s.status === 'paused' ? `<button class="btn sm" data-seg="${s.id}" data-st="working">Resume</button>` : `<button class="btn sm" data-act="${s.id}">Find more prospects</button><button class="btn sm" data-seg="${s.id}" data-st="paused">Pause segment</button>`}</div></div>`).join('')}</div>
      <p class="small muted" style="margin-top:12px">Segments that turn at least 5% of sends into leads move to <b>scaling</b> automatically. Value props: ${c.value_props.map(esc).join(' · ')}</p>`;
    $$('[data-act]', el).forEach((b) => b.onclick = async () => { b.disabled = true; b.innerHTML = '<span class="spinner"></span> Finding prospects and writing emails…'; try { const r = await api('POST', `/api/gtm/segments/${b.dataset.act}/activate`); toast(`${r.added} prospects found. Review the drafts in the approval queue.`); viewGtm(id, r.added ? 'approve' : 'overview'); } catch { b.disabled = false; b.textContent = 'Retry'; } });
    $$('[data-seg]', el).forEach((b) => b.onclick = async () => { await api('PATCH', `/api/gtm/segments/${b.dataset.seg}`, { status: b.dataset.st }); viewGtm(id, tab); });
  } else if (tab === 'approve') {
    const ps = await api('GET', `/api/gtm/campaigns/${id}/prospects?stage=pending_approval`);
    el.innerHTML = ps.length ? `<div class="row" style="margin-bottom:12px"><span class="muted">${ps.length} emails waiting. Edit anything, then approve.</span><span class="grow"></span><button class="btn primary" id="appall">Approve all ${ps.length}</button></div>
      ${ps.map((p) => { const d = p.messages.filter((m) => m.status === 'draft').pop(); return `<div class="panel card" style="margin-bottom:12px" data-p="${p.id}"><div class="row" style="justify-content:space-between"><div><b>${esc(p.first_name)} ${esc(p.last_name)}</b> <span class="muted">· ${esc(p.title)} at ${esc(p.company_name)} · ${esc(p.segment_name)}</span><div class="small muted">To ${esc(p.email)} from ${esc(p.inbox)}${d?.step > 1 ? ` · follow-up ${d.step}` : ''}</div></div>
        <div class="row"><button class="btn sm danger" data-rej="${p.id}">Skip prospect</button><button class="btn sm primary" data-ok="${p.id}">Approve</button></div></div>
        <input type="text" class="subj" value="${esc(d?.subject || '')}" style="margin-top:10px"><textarea class="bod" style="margin-top:8px">${esc(d?.body || '')}</textarea></div>`; }).join('')}` : '<div class="panel empty">Nothing to approve. Activate a segment to draft emails.</div>';
    const edits = (pid) => { const card = $(`[data-p="${pid}"]`, el); return { subject: $('.subj', card).value, body: $('.bod', card).value }; };
    $$('[data-ok]', el).forEach((b) => b.onclick = async () => { await api('POST', `/api/gtm/prospects/${b.dataset.ok}/review`, { ...edits(b.dataset.ok), action: 'approve' }); b.closest('.card').remove(); toast('Approved'); });
    $$('[data-rej]', el).forEach((b) => b.onclick = async () => { await api('POST', `/api/gtm/prospects/${b.dataset.rej}/review`, { action: 'reject' }); b.closest('.card').remove(); });
    const aa = $('#appall'); if (aa) aa.onclick = async () => { for (const card of $$('[data-p]', el)) await api('POST', `/api/gtm/prospects/${card.dataset.p}/review`, { ...edits(card.dataset.p), action: 'approve' }); toast(`Approved ${ps.length} emails`); viewGtm(id, 'approve'); };
  } else if (tab === 'inbox') {
    const ps = (await api('GET', `/api/gtm/campaigns/${id}/prospects`)).filter((p) => p.messages.some((m) => m.direction === 'in'));
    el.innerHTML = ps.length ? ps.map((p) => `<div class="thread panel"><div class="row" style="justify-content:space-between"><div><b>${esc(p.first_name)} ${esc(p.last_name)}</b> <span class="muted">· ${esc(p.title)} at ${esc(p.company_name)}</span></div>
      <div class="row"><span class="status ${p.lead_temp || ''}">${esc((p.lead_temp || 'replied').replace('_', ' '))}</span><span class="status ${p.stage}">${esc(p.stage.replace('_', ' '))}</span>${p.stage !== 'meeting' ? `<button class="btn sm" data-meet="${p.id}">Mark meeting booked</button>` : ''}</div></div>
      ${p.messages.map((m) => `<div class="msg ${m.direction}"><div class="small muted">${m.direction === 'in' ? 'Reply' : `${m.status === 'draft' ? 'Draft (needs approval)' : m.status === 'scheduled' ? 'Queued' : 'Sent'}`}${m.classification ? ` · classified ${esc(m.classification.replace('_', ' '))}` : ''}</div><b>${esc(m.subject)}</b>\n${esc(m.body)}</div>`).join('')}
      ${p.messages.some((m) => m.status === 'draft') ? `<button class="btn sm primary" data-okd="${p.id}">Approve drafted reply</button>` : ''}
      <form class="row" data-reply="${p.id}" style="margin-top:8px"><input type="text" name="body" placeholder="Write a reply…" style="flex:1" required><button class="btn sm">Send</button></form></div>`).join('') : '<div class="panel empty">No replies yet. Replies show up here and are classified hot, warm or not interested.</div>';
    $$('[data-meet]', el).forEach((b) => b.onclick = async () => { await api('POST', `/api/gtm/prospects/${b.dataset.meet}/meeting`); viewGtm(id, 'inbox'); });
    $$('[data-okd]', el).forEach((b) => b.onclick = async () => { await api('POST', `/api/gtm/prospects/${b.dataset.okd}/review`, { action: 'approve' }); viewGtm(id, 'inbox'); });
    $$('[data-reply]', el).forEach((f) => f.onsubmit = async (e) => { e.preventDefault(); await api('POST', `/api/gtm/prospects/${f.dataset.reply}/reply`, { subject: 'Re:', body: new FormData(f).get('body') }); toast('Reply queued'); viewGtm(id, 'inbox'); });
  } else if (tab === 'prospects') {
    const ps = await api('GET', `/api/gtm/campaigns/${id}/prospects`);
    el.innerHTML = `<section class="panel"><div class="table-wrap"><table><thead><tr><th>Prospect</th><th>Company</th><th>Segment</th><th>Stage</th><th>Lead</th><th>Inbox</th><th class="right">Emails</th></tr></thead><tbody>
      ${ps.map((p) => `<tr><td><b>${esc(p.first_name)} ${esc(p.last_name)}</b><div class="small muted">${esc(p.title)}</div></td><td>${esc(p.company_name)}</td><td class="small">${esc(p.segment_name)}</td><td><span class="status ${p.stage}">${esc(p.stage.replace('_', ' '))}</span></td><td>${p.lead_temp ? `<span class="status ${p.lead_temp}">${esc(p.lead_temp.replace('_', ' '))}</span>` : ''}</td><td class="small">${esc(p.inbox)}</td><td class="right">${p.messages.filter((m) => m.direction === 'out' && m.status === 'sent').length}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No prospects yet</td></tr>'}</tbody></table></div></section>`;
  } else if (tab === 'settings') {
    el.innerHTML = `<form class="panel card stack" id="setf" style="max-width:640px">
      <div class="grid g2"><label class="field"><span>Sender name</span><input type="text" name="sender_name" value="${esc(c.sender_name)}"></label><label class="field"><span>Sender title</span><input type="text" name="sender_title" value="${esc(c.sender_title)}"></label></div>
      <label class="field"><span>Meeting link</span><input type="url" name="meeting_link" value="${esc(c.meeting_link)}" placeholder="https://cal.com/you/15min"></label>
      <div class="grid g2"><label class="field"><span>Email language</span><input type="text" name="language" value="${esc(c.language)}"></label><label class="field"><span>Daily send limit</span><input type="number" name="daily_limit" min="1" max="500" value="${c.daily_limit}"></label></div>
      <label class="field"><span>Budget (USD)</span><input type="number" name="budget_usd" min="1" step="1" value="${c.budget_usd}"></label>
      <label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="auto_approve" ${c.auto_approve ? 'checked' : ''}><span><b>Send without my approval</b><br><span class="small muted">Off by default. When on, drafted emails and follow-ups send automatically.</span></span></label>
      <div><h3>Sending inboxes</h3>${c.inboxes.map((i) => `<div class="row small"><span>${esc(i.address)}</span><span class="status running">warm-up ${i.warmup_score}</span><span class="muted">${i.sent_today} sent today</span></div>`).join('')}<p class="small muted">Separate sending domains protect your main domain's reputation. Connect your own SMTP or Google Workspace inboxes in production.</p></div>
      <button class="btn primary" style="width:max-content">Save settings</button></form>`;
    $('#setf').onsubmit = async (e) => { e.preventDefault(); const fd = new FormData(e.target); await api('PATCH', `/api/gtm/campaigns/${id}`, { sender_name: fd.get('sender_name'), sender_title: fd.get('sender_title'), meeting_link: fd.get('meeting_link'), language: fd.get('language'), daily_limit: +fd.get('daily_limit'), budget_usd: +fd.get('budget_usd'), auto_approve: fd.get('auto_approve') === 'on' }); toast('Saved'); viewGtm(id, 'settings'); };
  }
  if (c.status === 'running' && ['overview', 'inbox', 'prospects'].includes(tab)) gtmPoll = setInterval(() => { if (location.hash === `#/autogtm/${id}`) viewGtm(id, tab); else clearInterval(gtmPoll); }, 8000);
}

function newCampaign() {
  const m = modal(`<h2>New AutoGTM campaign</h2><div class="steps"><span class="on">1. Your product</span><span>2. Segments</span><span>3. Approve emails</span></div>
    <form id="ncf" class="stack">
      <label class="field"><span>Your website</span><input type="text" name="website" required placeholder="yourcompany.com"></label>
      <div class="grid g2"><label class="field"><span>Sender name</span><input type="text" name="sender_name" value="${esc(state.me.name || '')}" required></label><label class="field"><span>Sender title</span><input type="text" name="sender_title" value="Founder"></label></div>
      <label class="field"><span>Meeting link (optional)</span><input type="url" name="meeting_link" placeholder="https://cal.com/you/15min"></label>
      <label class="field"><span>Budget: <b id="bv">$30</b> · about <b id="be">1,000</b> emails</span><input type="range" name="budget_usd" min="10" max="100" step="10" value="30" style="width:100%"></label>
      <label style="display:flex;gap:8px"><input type="checkbox" name="auto_approve"><span class="small">Send without my approval (not recommended for your first campaign)</span></label>
      <div class="row"><span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Analyse my website</button></div></form>`, { wide: true });
  const r = $('[name=budget_usd]', m); r.oninput = () => { $('#bv').textContent = `$${r.value}`; $('#be').textContent = fmt(Math.floor(r.value / 0.03)); };
  $('#ncf').onsubmit = async (e) => {
    e.preventDefault(); const b = $('button.primary', m); b.disabled = true; b.innerHTML = '<span class="spinner"></span> Reading your site and mapping buyers…';
    const fd = new FormData(e.target);
    try { const c = await api('POST', '/api/gtm/campaigns', { website: fd.get('website'), sender_name: fd.get('sender_name'), sender_title: fd.get('sender_title'), meeting_link: fd.get('meeting_link'), budget_usd: +fd.get('budget_usd'), auto_approve: fd.get('auto_approve') === 'on' }); closeModal(); location.hash = `#/autogtm/${c.id}`; }
    catch { b.disabled = false; b.textContent = 'Try again'; }
  };
}

// ---------------------------------------------------------------- router
function route() {
  closeDrawer(); clearInterval(gtmPoll);
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
  const view = parts[0] || 'search';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));
  if (view === 'search') return viewSearch();
  if (view === 'people') return viewPeople();
  if (view === 'lookalike') return viewLookalike();
  if (view === 'lists') return viewLists(parts[1]);
  if (view === 'history') return viewHistory();
  if (view === 'billing') return viewBilling();
  if (view === 'autogtm') return viewGtm(parts[1]);
  $('#app').innerHTML = '<div class="empty">Page not found. <a href="#/">Go to search</a></div>';
}
window.addEventListener('hashchange', route);
(async () => { state.meta = await api('GET', '/api/meta'); await loadMe(); route(); })();
