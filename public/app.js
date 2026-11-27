'use strict';
/* Expenses dashboard. Reads/writes data/expenses.json through the local server (server.py). */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const isoDate = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
let FMTR = makeFormat();   // regional format; rebuilt from the settings every time the data is loaded
const fmtDate = iso => (iso ? FMTR.date(iso) : '—');
const fmtMonth = ym => { const [y, m] = ym.split('-'); return `${MONTHS[+m - 1]} ${y}`; };
const fmtMoney = (v, cur) => FMTR.money(v, cur);
const byName = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });
const sortedCats = d => [...d.categories].sort((a, b) => byName(a.name, b.name));
const sortedSubs = c => [...c.subcategories].sort(byName);
const catEmoji = name => S.doc?.categories.find(c => c.name === name)?.emoji || '🏷️';
const tripById = id => (id ? S.doc?.trips?.find(t => t.id === id) : null);
/** The trip whose dates contain the given day (the shortest one if several overlap). */
const tripOnDate = date => (S.doc?.trips || []).filter(t => t.start <= date && date <= t.end).sort((a, b) => daysBetween(a.start, a.end) - daysBetween(b.start, b.end))[0];
const subEmoji = (cat, sub) => (S.doc?.categories.find(c => c.name === cat)?.subcategoryEmoji?.[sub]) || '';
const emo = e => (e ? e + ' ' : '');
const cents = v => Math.round(v * 100);
const sumC = list => list.reduce((s, e) => s + cents(e.amount), 0);
const money = (c, cur) => fmtMoney(c / 100, cur);

const RC_OK = /\.(jpe?g|png|webp|gif|heic|heif|pdf)$/i, RC_PREVIEW = /\.(jpe?g|png|webp|gif)$/i, RC_MAX = 25 * 1024 * 1024;
const fmtSize = b => b >= 1048576 ? FMTR.fixed(b / 1048576, 1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

const S = {
  history: [],
  history: [],
  doc: null, loading: true, error: null,
  f: { mode: 'month', year: 0, month: 0, from: '', to: '', q: '', category: '', subcategory: '', merchant: '', currency: '' },
  tripSel: '', tripsGroup: 'trip',
  group: 'none', sort: { key: 'date', dir: 'desc' }, limit: 100, showTrendTable: false, expanded: new Set(), catSort: 'alpha', collapsed: new Set(),
};

/** The Trips tab is the Dashboard limited to expenses assigned to a trip, with no period. */
const inTrips = () => document.body.dataset.view === 'trips';

/* ---------- what the page remembers across a reload (Cmd+R): tab, filters, grouping, selected trip. Kept per browser tab. ---------- */
const UI_KEY = 'expenses.ui.v1';
function saveUi() {
  try { sessionStorage.setItem(UI_KEY, JSON.stringify({ tab: document.body.dataset.view || 'dash', f: S.f, group: S.group, tripsGroup: S.tripsGroup, tripSel: S.tripSel, sort: S.sort, section: typeof ST !== 'undefined' ? ST.section : '' })); } catch { /* storage may be blocked: the page just forgets */ }
}
function restoreUi() {
  let u = null; try { u = JSON.parse(sessionStorage.getItem(UI_KEY) || 'null'); } catch { u = null; }
  if (!u || typeof u !== 'object') return;
  const f = u.f || {};
  if (['month', 'year', 'all', 'custom'].includes(f.mode)) S.f.mode = f.mode;
  ['year', 'month'].forEach(k => { if (Number.isInteger(f[k]) && f[k] > 0) S.f[k] = f[k]; });
  ['from', 'to', 'q', 'merchant'].forEach(k => { if (typeof f[k] === 'string') S.f[k] = f[k]; });
  if (typeof f.currency === 'string' && S.doc.expenses.some(e => e.currency === f.currency)) S.f.currency = f.currency;
  const cat = S.doc.categories.find(c => c.name === f.category);
  if (cat) { S.f.category = cat.name; if (cat.subcategories.includes(f.subcategory)) S.f.subcategory = f.subcategory; }
  if (['none', 'category', 'subcategory', 'merchant', 'month'].includes(u.group)) S.group = u.group;
  if (['none', 'category', 'subcategory', 'merchant', 'month', 'trip'].includes(u.tripsGroup)) S.tripsGroup = u.tripsGroup;
  S.tripSel = (S.doc.trips || []).some(t => t.id === u.tripSel) ? u.tripSel : '';
  if (u.sort && ['date', 'merchant', 'category', 'amount'].includes(u.sort.key) && ['asc', 'desc'].includes(u.sort.dir)) S.sort = u.sort;
  if (typeof ST !== 'undefined' && u.section) ST.section = u.section;
  S.restoreTab = ['trips', 'data', 'settings'].includes(u.tab) ? u.tab : '';
  $('#fSearch').value = S.f.q; $('#fMerchant').value = S.f.merchant;
}

/* ---------- API ---------- */
async function api(method, path, body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'expenses-ui' },
    body: body ? JSON.stringify({ ...body, baseRevision: S.doc.revision }) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(r.status === 404 && j.error === 'Not found.' ? 'The server is running an older version. Close its Terminal window and open Start Expenses.command again (keep this page open).' : j.error || `Request failed (${r.status})`); e.status = r.status; e.details = j.details || []; throw e; }
  return j;
}

async function loadData(initial) {
  if (initial) { S.loading = true; S.error = null; renderAll(); }
  try {
    const r = await fetch('/api/data', { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `Failed to load (${r.status})`);
    S.doc = j; S.error = null; FMTR = makeFormat(j.settings?.format, j.systemFormat);
    await loadHistory();
    if (initial) initFilters();
  } catch (e) {
    S.error = e.message === 'Failed to fetch' ? 'Could not reach the local server. Is it running? (python3 server.py)' : e.message;
  }
  S.loading = false;
  renderAll();
  if (initial && S.restoreTab) { const t = S.restoreTab; S.restoreTab = ''; await setTab(t); }
}

/* ---------- undo history (kept by the server: the last 10 saved actions) ---------- */
async function loadHistory() {
  try { S.history = (await (await fetch('/api/history', { cache: 'no-store' })).json()).history || []; } catch { S.history = []; }
  renderUndoBtn();
}
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
  const d = new Date(iso), same = d.toDateString() === new Date().toDateString();
  return same ? `today ${FMTR.time(d)}` : `${fmtDate(d.toLocaleDateString('en-CA'))} ${FMTR.time(d)}`;
}
function renderUndoBtn() {
  const b = $('#btnUndo'); if (!b) return;
  b.disabled = !S.history.length;
  b.title = S.history.length ? `Undo: ${S.history[0].label} (⌘Z / Ctrl+Z)` : 'Nothing to undo yet';
  b.innerHTML = `↩️ Undo${S.history.length ? ` <span class="badge">${S.history.length}</span>` : ''}`;
}
function renderUndoMenu() {
  $('#undoMenu').innerHTML = S.history.length
    ? `<div class="undohead">Recent actions <span class="muted small">· choosing one undoes it and everything above it</span></div>` +
      S.history.map((h, i) => `<button type="button" role="menuitem" class="undoitem" data-undo="${esc(h.id)}" data-i="${i}"><span class="ul">${esc(h.label)}</span><span class="ut muted small">${esc(ago(h.at))}</span></button>`).join('') +
      `<div class="undofoot muted small">The last ${S.history.length} of up to 10 actions are kept. Undoing can itself be undone.</div>`
    : '<div class="undohead muted">Nothing to undo yet.</div>';
}
function toggleUndoMenu(open) {
  const m = $('#undoMenu'), b = $('#btnUndo'), show = open ?? m.hidden;
  if (show) renderUndoMenu();
  m.hidden = !show; b.setAttribute('aria-expanded', String(show));
}
async function doUndo(id, { confirm = false } = {}) {
  toggleUndoMenu(false);
  const idx = S.history.findIndex(h => h.id === id);
  if (idx < 0) return toast('That action is no longer available.', true);
  const items = S.history.slice(0, idx + 1);
  const unsaved = typeof D !== 'undefined' && D.pending.size;
  if (confirm || items.length > 1 || unsaved) {
    const ok = await confirmDlg({ title: `Undo ${items.length} ${items.length === 1 ? 'action' : 'actions'}?`,
      body: `<ul style="margin:0 0 8px;padding-left:18px">${items.map(h => `<li>${esc(h.label)}</li>`).join('')}</ul>${unsaved ? '<p class="small">Your unsaved edits in the Data tab will be discarded.</p>' : ''}`, ok: 'Undo' });
    if (!ok) return;
  }
  try {
    const j = await api('POST', '/undo', { actionId: id });
    if (typeof D !== 'undefined') D.pending.clear();
    await loadData(false);
    const redo = j.undone.length === 1 && /^Undid|^Redid/.test(j.undone[0]);
    toast(redo ? 'Redone.' : `Undone: ${j.undone.length === 1 ? j.undone[0] : j.undone.length + ' actions'}`, false, { label: 'Redo', run: () => doUndo(S.history[0]?.id) });
  } catch (e) { toast(`Could not undo: ${e.message}`, true); }
}
const toastUndo = msg => toast(msg, false, { label: 'Undo', run: () => doUndo(S.history[0]?.id) });

function initFilters() {
  const ds = S.doc.expenses.map(e => e.date).sort();
  const today = new Date().toISOString().slice(0, 10);
  const pick = ds.some(d => d.slice(0, 7) === today.slice(0, 7)) ? today : (ds.filter(d => d <= today).pop() || ds[ds.length - 1] || today);
  S.f.year = +pick.slice(0, 4); S.f.month = +pick.slice(5, 7);
  const cur = {};
  S.doc.expenses.forEach(e => cur[e.currency] = (cur[e.currency] || 0) + 1);
  S.f.currency = Object.keys(cur).sort((a, b) => cur[b] - cur[a])[0] || 'EUR';
  restoreUi();
}

/* ---------- periods & filtering ---------- */
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5) + 1; }
function monthRange(y, m) { return [isoDate(y, m, 1), isoDate(y, m, new Date(y, m, 0).getDate())]; }
function periodRange(f = S.f) {
  if (inTrips() || f.mode === 'all') return null;
  if (f.mode === 'year') return [`${f.year}-01-01`, `${f.year}-12-31`];
  if (f.mode === 'month') return monthRange(f.year, f.month);
  return [f.from || '0000-01-01', f.to || '9999-12-31'];
}
function prevRange(f = S.f) {
  if (inTrips()) return null;
  if (f.mode === 'year') return [`${f.year - 1}-01-01`, `${f.year - 1}-12-31`];
  if (f.mode === 'month') { const y = f.month === 1 ? f.year - 1 : f.year, m = f.month === 1 ? 12 : f.month - 1; return monthRange(y, m); }
  if (f.mode === 'custom' && f.from && f.to && f.from <= f.to) { const n = daysBetween(f.from, f.to); return [addDays(f.from, -n), addDays(f.from, -1)]; }
  return null;
}
function periodLabel() {
  const f = S.f;
  if (inTrips()) return tripById(S.tripSel)?.name || 'All trips';
  if (f.mode === 'all') return 'All time';
  if (f.mode === 'year') return String(f.year);
  if (f.mode === 'month') return `${MONTHS[f.month - 1]} ${f.year}`;
  return `${f.from ? fmtDate(f.from) : 'Start'} – ${f.to ? fmtDate(f.to) : 'Today'}`;
}
const inRange = (e, r) => !r || (e.date >= r[0] && e.date <= r[1]);

function matchesBase(e, { ignoreCategory = false, ignoreTrip = false } = {}) {
  const f = S.f;
  if (e.currency !== f.currency) return false;
  if (inTrips() && !ignoreTrip && (S.tripSel ? e.tripId !== S.tripSel : !e.tripId)) return false;
  if (!ignoreCategory) {
    if (f.category && e.category !== f.category) return false;
    if (f.subcategory && e.subcategory !== f.subcategory) return false;
  }
  if (f.merchant && !searchMatch(searchWords(f.merchant), [e.merchant])) return false;
  if (f.q) {
    if (!searchMatch(searchWords(f.q), [e.merchant, e.category, e.subcategory], `${e.notes} ${e.amount.toFixed(2)} ${textDate(e.date)} ${fmtDate(e.date)}`)) return false;
  }
  return true;
}
const select = (range, opts) => S.doc.expenses.filter(e => matchesBase(e, opts) && inRange(e, range));

/* ---------- rendering ---------- */
function renderAll() {
  renderBanner(); renderControls();
  const body = ['summary', 'cardCats', 'cardTrend', 'cardTable'].map(id => $('#' + id));
  if (S.loading) {
    $('#summary').innerHTML = [1, 2, 3, 4].map(() => '<div class="stat"><div class="skeleton" style="width:50%"></div><div class="skeleton" style="height:30px"></div></div>').join('');
    ['cardCats', 'cardTrend', 'cardTable'].forEach(id => $('#' + id).innerHTML = '<div class="skeleton" style="width:40%"></div>' + '<div class="skeleton"></div>'.repeat(5));
    return;
  }
  if (!S.doc) {
    body.forEach(b => b.innerHTML = '');
    $('#cardTable').innerHTML = `<div class="state-box"><p><strong>Data could not be loaded.</strong></p><button class="btn" id="btnRetry">Try again</button></div>`;
    return;
  }
  if (S.tripSel && !tripById(S.tripSel)) S.tripSel = '';   // the selected trip was deleted
  $('#cardTrend').hidden = inTrips();
  renderSummary(); renderCats(); renderTrend(); renderTable();
  if (typeof renderTripsCard === 'function') renderTripsCard();
  if (typeof renderExtras === 'function') renderExtras();
  saveUi();
}

function renderBanner() {
  $('#banner').innerHTML = S.error
    ? `<div class="alert"><span><strong>Error:</strong> ${esc(S.error)}</span><button class="btn" id="btnRetry">Reload data</button></div>` : '';
}

function renderControls() {
  const f = S.f, d = S.doc;
  document.querySelectorAll('#modeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === f.mode)));
  const years = d ? [...new Set(d.expenses.map(e => +e.date.slice(0, 4)).concat(f.year))].sort() : [f.year];
  let html = '';
  if (f.mode === 'month') {
    html = `<button class="btn iconbtn" data-step="-1" aria-label="Previous month">‹</button>
      <label class="field"><span>Month</span><select id="pMonth">${MONTHS.map((m, i) => `<option value="${i + 1}" ${f.month === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label class="field"><span>Year</span><select id="pYear">${years.map(y => `<option ${y === f.year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <button class="btn iconbtn" data-step="1" aria-label="Next month">›</button>`;
  } else if (f.mode === 'year') {
    html = `<button class="btn iconbtn" data-step="-1" aria-label="Previous year">‹</button>
      <label class="field"><span>Year</span><select id="pYear">${years.map(y => `<option ${y === f.year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <button class="btn iconbtn" data-step="1" aria-label="Next year">›</button>`;
  } else if (f.mode === 'custom') {
    html = `<label class="field"><span>From</span><input type="date" id="pFrom" value="${esc(f.from)}"></label>
      <label class="field"><span>To</span><input type="date" id="pTo" value="${esc(f.to)}"></label>`;
  }
  const pk = $('#pickers'); if (pk.dataset.sig !== html) { pk.innerHTML = html; pk.dataset.sig = html; }
  const active = !!(f.q || f.category || f.subcategory || f.merchant);
  $('#btnClear').disabled = !active;
  if (!d) return;
  const cats = sortedCats(d);
  const optsC = `<option value="">All categories</option>` + cats.map(c => `<option value="${esc(c.name)}" ${c.name === f.category ? 'selected' : ''}>${catEmoji(c.name)} ${esc(c.name)}</option>`).join('');
  const sub = cats.find(c => c.name === f.category);
  const SEP = '\u0001';  // option value for the grouped list: "<category>\u0001<subcategory>"
  const optsS = `<option value="">All subcategories</option>` + (sub
    ? sortedSubs(sub).map(s => `<option value="${esc(s)}" ${s === f.subcategory ? 'selected' : ''}>${emo(subEmoji(sub.name, s))}${esc(s)}</option>`).join('')
    : cats.filter(c => c.subcategories.length).map(c => `<optgroup label="${catEmoji(c.name)} ${esc(c.name.toUpperCase())}">${sortedSubs(c).map(s => `<option value="${esc(c.name + SEP + s)}">\u00a0\u00a0\u00a0\u00a0${emo(subEmoji(c.name, s))}${esc(s)}</option>`).join('')}</optgroup>`).join(''));
  const curs = [...new Set(d.expenses.map(e => e.currency))].sort();
  $('#fCurrencyWrap').hidden = curs.length < 2;  // the currency filter only appears when there is more than one currency
  const optsU = curs.map(c => `<option ${c === f.currency ? 'selected' : ''}>${esc(c)}</option>`).join('');
  if ($('#fCategory').innerHTML !== optsC) $('#fCategory').innerHTML = optsC;
  if ($('#fSub').innerHTML !== optsS) $('#fSub').innerHTML = optsS;
  if ($('#fCurrency').innerHTML !== optsU) $('#fCurrency').innerHTML = optsU;
  $('#fCategory').value = f.category; $('#fSub').value = sub ? f.subcategory : ''; $('#fCurrency').value = f.currency;
  // Merchant suggestions follow the selected category, subcategory and currency; the Add/Edit form gets the full list.
  const names = list => [...new Set(list.map(e => e.merchant))].sort(byName).map(m => `<option value="${esc(m)}">`).join('');
  const scoped = names(d.expenses.filter(e => e.currency === f.currency && (!f.category || e.category === f.category) && (!f.subcategory || e.subcategory === f.subcategory)));
  if ($('#merchantList').innerHTML !== scoped) $('#merchantList').innerHTML = scoped;
  const all = names(d.expenses);
  if ($('#merchantListAll').innerHTML !== all) $('#merchantListAll').innerHTML = all;
}

function renderSummary() {
  const f = S.f, cur = f.currency, r = periodRange(), pr = prevRange();
  const list = select(r), net = sumC(list), refunds = sumC(list.filter(e => e.amount < 0));
  const prevNet = pr ? sumC(select(pr)) : null;
  const others = [...new Set(S.doc.expenses.map(e => e.currency))].filter(c => c !== cur);
  const otherTxt = others.map(c => `${c}: ${money(sumC(S.doc.expenses.filter(e => e.currency === c && inRange(e, r) && matchesBase({ ...e, currency: cur }))), c)}`).join(' · ');
  const tp = inTrips() ? tripById(S.tripSel) : null, tdays = tp ? daysBetween(tp.start, tp.end) : 0;
  const tripNote = !inTrips() ? '' : tp ? `${tdays} ${tdays === 1 ? 'day' : 'days'} · ${money(Math.round(net / tdays), cur)} per day` : `${new Set(list.map(e => e.tripId)).size} trips`;
  const note = [tripNote, refunds ? `Includes refunds of ${money(Math.abs(refunds), cur)}` : '', others.length ? `Other currencies: ${otherTxt || '—'}` : ''].filter(Boolean);
  let cmp = '';
  if (pr) {
    const diff = net - prevNet, pct = prevNet ? Math.abs(diff / prevNet * 100).toFixed(0) : null;
    const plabel = f.mode === 'month' ? `${MONTHS[+pr[0].slice(5, 7) - 1]} ${pr[0].slice(0, 4)}` : f.mode === 'year' ? pr[0].slice(0, 4) : `${fmtDate(pr[0])} – ${fmtDate(pr[1])}`;
    cmp = `<div class="cmp"><div class="label">vs previous period · ${esc(plabel)}</div>
      <div class="cmpval">${diff === 0 ? 'No change' : `${diff > 0 ? '▲' : '▼'} ${money(Math.abs(diff), cur)}${pct !== null ? ` <small>${diff > 0 ? '+' : '−'}${pct}%</small>` : ''}`}</div>
      <div class="sub">Previous: ${money(prevNet, cur)}</div></div>`;
  }
  $('#summary').innerHTML = `
    <div class="stat split ${cmp ? '' : 'solo'}"><div class="main"><div class="label">💶 Total spent · ${esc(periodLabel())}</div><div class="value">${money(net, cur)}</div>
      ${note.length ? `<div class="sub">${esc(note.join(' · '))}</div>` : ''}</div>${cmp}</div>`;
}

function buildTree(list, mode = S.catSort) {
  const m = new Map();
  list.forEach(e => {
    const c = m.get(e.category) || { key: e.category, c: 0, n: 0, subs: new Map() };
    c.c += cents(e.amount); c.n++;
    const sk = e.subcategory || '(None)', x = c.subs.get(sk) || { key: sk, c: 0, n: 0 };
    x.c += cents(e.amount); x.n++; c.subs.set(sk, x); m.set(e.category, c);
  });
  const order = mode === 'alpha'
    ? (a, b) => ((a.key === '(None)') - (b.key === '(None)')) || byName(a.key, b.key)
    : (a, b) => b.c - a.c;
  return [...m.values()].map(c => ({ ...c, subs: [...c.subs.values()].sort(order) })).sort(order);
}

function renderCats() {
  const f = S.f, cur = f.currency, r = periodRange(), pr = prevRange();
  const list = select(r, { ignoreCategory: true }), total = sumC(list);
  const tree = buildTree(list);
  const prev = new Map();
  if (pr) buildTree(select(pr, { ignoreCategory: true })).forEach(c => { prev.set(c.key, c.c); c.subs.forEach(x => prev.set(c.key + '\u0000' + x.key, x.c)); });
  const max = Math.max(1, ...tree.map(c => Math.abs(c.c)));
  const bar = (v, p, mx) => `<span class="barbox"><span class="bartrack"><span class="barfill" style="width:${Math.min(100, Math.abs(v) / mx * 100)}%"></span></span>${p ? `<i class="prevmark" style="left:${Math.min(100, Math.abs(p) / mx * 100)}%"></i>` : ''}</span>`;
  const tipFor = (name, v, n, p) => `${name}: ${money(v, cur)} (${n} entries)` + (pr ? `. Previous period: ${money(p || 0, cur)}` : '');
  const rows = tree.map(c => {
    const open = S.expanded.has(c.key), pv = prev.get(c.key) || 0, sel = f.category === c.key && !f.subcategory;
    const subs = open ? `<div class="subrows">${c.subs.map(x => {
      const sp = prev.get(c.key + '\u0000' + x.key) || 0, filt = x.key !== '(None)', ssel = f.category === c.key && f.subcategory === x.key;
      return `<${filt ? 'button type="button"' : 'div'} class="subrow ${filt ? 'click' : ''} ${ssel ? 'sel' : ''}" ${filt ? `data-filtersub="${esc(x.key)}" data-cat="${esc(c.key)}"` : ''} data-tip="${esc(tipFor(x.key, x.c, x.n, sp))}">
        <span class="barname">${emo(subEmoji(c.key, x.key))}${esc(x.key)}</span>${bar(x.c, sp, Math.max(1, Math.abs(c.c)))}
        <span class="barval">${money(x.c, cur)}<small>${c.c ? (x.c / c.c * 100).toFixed(0) : 0}%</small></span></${filt ? 'button' : 'div'}>`;
    }).join('')}</div>` : '';
    return `<div class="catgroup ${open ? 'open' : ''}">
      <div class="catline ${sel ? 'sel' : ''}"><button type="button" class="barrow click" data-toggle="${esc(c.key)}" aria-expanded="${open}" data-tip="${esc(tipFor(c.key, c.c, c.n, pv))}">
        <span class="barname"><span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>${catEmoji(c.key)} ${esc(c.key)}</span>${bar(c.c, pv, max)}
        <span class="barval">${money(c.c, cur)}<small>${total ? (c.c / total * 100).toFixed(0) : 0}%</small></span></button>
        <button type="button" class="link small filterlink" data-filtercat="${esc(c.key)}" title="Show only this category in the table">${sel ? 'Clear' : 'Filter'}</button></div>${subs}</div>`;
  }).join('');
  const allOpen = tree.length && tree.every(c => S.expanded.has(c.key));
  $('#cardCats').innerHTML = `<div class="card-head"><h2>📂 Spending by category</h2>
      <span class="crumbs">${esc(periodLabel())} · <button class="link" data-expandall="${allOpen ? '0' : '1'}">${allOpen ? 'Collapse all' : 'Expand all'}</button> · <button class="link" data-catsort title="Change the order of the categories">Sort: ${S.catSort === 'alpha' ? 'A–Z' : 'amount'}</button></span></div>
    ${tree.length ? `<div class="cattree">${rows}</div>` : emptyBox('No expenses for this period and filters.')}
    ${pr && tree.length ? `<div class="legend"><span><i style="background:var(--accent)"></i>This period</span><span><i class="tri"></i>Previous period</span></div>` : ''}`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function trendMonths() {
  const f = S.f, all = S.doc.expenses.filter(e => matchesBase(e)).map(e => e.date.slice(0, 7)).sort();
  const ym = (y, m) => `${y}-${pad(m)}`;
  const span = (a, b) => { const out = []; let [y, m] = a.split('-').map(Number); const [y2, m2] = b.split('-').map(Number); while (y < y2 || (y === y2 && m <= m2)) { out.push(ym(y, m)); if (++m > 12) { m = 1; y++; } } return out; };
  if (f.mode === 'year') return span(ym(f.year, 1), ym(f.year, 12));
  if (f.mode === 'month') { /* 12 months ending one month after the selected one, so the next month stays visible */ let ey = f.year, em = f.month + 1; if (em > 12) { em = 1; ey++; } let y = ey, m = em - 11; if (m < 1) { m += 12; y--; } return span(ym(y, m), ym(ey, em)); }
  if (!all.length) return [];
  let a = all[0], b = all[all.length - 1];
  if (f.mode === 'custom') { if (f.from) a = f.from.slice(0, 7); if (f.to) b = f.to.slice(0, 7); }
  const out = span(a, b); return out.slice(-36);
}
function renderTrend() {
  if (inTrips()) return;
  const cur = S.f.currency, months = trendMonths(), r = periodRange();
  const by = new Map(months.map(m => [m, { c: 0, n: 0 }]));
  S.doc.expenses.filter(e => matchesBase(e)).forEach(e => { const o = by.get(e.date.slice(0, 7)); if (o) { o.c += cents(e.amount); o.n++; } });
  const vals = months.map(m => by.get(m));
  const W = 640, H = 230, L = 52, B = 26, T = 8, plotW = W - L - 4, plotH = H - B - T;
  const max = niceMax(Math.max(0, ...vals.map(v => v.c)) / 100);
  const bw = plotW / Math.max(months.length, 1), barW = Math.max(3, Math.min(34, bw * .66));
  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const v = max / 4 * i, y = T + plotH - (v / max) * plotH;
    svg += `<line class="grid" x1="${L}" x2="${W - 4}" y1="${y}" y2="${y}"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${v >= 1000 ? FMTR.fixed(v / 1000, v % 1000 ? 1 : 0) + 'k' : v.toFixed(0)}</text>`;
  }
  const every = months.length > 24 ? 6 : months.length > 12 ? 3 : 1;
  months.forEach((m, i) => {
    const v = vals[i], h = Math.max(0, v.c / 100 / max * plotH), x = L + bw * i + (bw - barW) / 2, y = T + plotH - h;
    const on = !r || (m + '-31' >= r[0] && m + '-01' <= r[1]);
    const tip = `${fmtMonth(m)}: ${money(v.c, cur)} (${v.n} entries)`;
    if (v.c > 0) { const bh = Math.max(3, h); svg += `<rect class="bar ${on ? 'on' : ''}" data-month="${m}" tabindex="0" role="button" aria-label="${esc(tip)}" data-tip="${esc(tip)}" x="${x}" y="${T + plotH - bh}" width="${barW}" height="${bh}" rx="3"/>`; }
    if (i % every === 0 || i === months.length - 1) svg += `<text x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${MONTHS[+m.slice(5) - 1]}${m.slice(5) === '01' || i === 0 ? ' ' + m.slice(2, 4) : ''}</text>`;
  });
  $('#cardTrend').innerHTML = `<div class="card-head"><h2>📈 Monthly trend</h2><span class="crumbs"><button class="link" id="btnTrendTable">${S.showTrendTable ? 'Show chart' : 'Show data table'}</button></span></div>
    ${!months.length ? emptyBox('No data to chart.') : S.showTrendTable
      ? `<table class="datatable"><thead><tr><th>Month</th><th>Entries</th><th>Total</th></tr></thead><tbody>${months.map((m, i) => `<tr><td>${fmtMonth(m)}</td><td>${vals[i].n}</td><td>${money(vals[i].c, cur)}</td></tr>`).join('')}</tbody></table>`
      : `<div class="trend"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly total spent in ${esc(cur)}">${svg}</svg></div>
         <div class="legend"><span><i style="background:var(--accent)"></i>Selected period</span><span><i style="background:var(--accent-dim)"></i>Other months · click a bar to open that month</span></div>`}`;
}

const emptyBox = msg => `<div class="empty">${esc(msg)}</div>`;

/* table */
function sortedList(list) {
  const { key, dir } = S.sort, m = dir === 'asc' ? 1 : -1;
  const val = { date: e => e.date, merchant: e => e.merchant.toLowerCase(), category: e => `${e.category} ${e.subcategory}`.toLowerCase(), amount: e => e.amount }[key];
  return [...list].sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * m || (a.date < b.date ? 1 : -1); });
}
function detailsHtml(e, withNotes = true) {
  const clip = e.receiptFile ? `<a class="ic" href="/receipts/${encodeURIComponent(e.receiptFile.replace(/^Receipts\//, ''))}" target="_blank" rel="noopener" data-tip="Receipt: ${esc(e.receiptFile.replace(/^Receipts\//, ''))}" aria-label="Open receipt">📎</a>` : '';
  const note = withNotes && e.notes ? `<span class="ic" data-tip="${esc(e.notes.length > 120 ? e.notes.slice(0, 120) + '…' : e.notes)}" aria-label="Has notes">📝</span>` : '';
  const tr = tripById(e.tripId), trip = tr ? `<span class="ic" role="button" tabindex="0" data-trip="${esc(tr.id)}" data-tip="${esc('Trip: ' + tr.name + ' (click to open it in the Trips tab)')}" aria-label="Open the trip ${esc(tr.name)}">🧳</span>` : '';
  const inst = e.installment ? `<span class="chip" data-tip="Installment ${e.installment.index} of ${e.installment.count}">💳 ${e.installment.index}/${e.installment.count}</span>` : '';
  return clip + note + trip + inst;
}
function renderTable() {
  const cur = S.f.currency, r = periodRange(), list = sortedList(select(r)), g = inTrips() ? (S.tripSel && S.tripsGroup === 'trip' ? 'none' : S.tripsGroup) : S.group;
  const keyFn = { category: e => e.category, subcategory: e => `${e.category} › ${e.subcategory || '(None)'}`, merchant: e => e.merchant, month: e => fmtMonth(e.date.slice(0, 7)), trip: e => tripById(e.tripId)?.name || '(no trip)' }[g];
  let items = [];
  if (!keyFn) list.forEach(e => items.push({ e }));
  else {
    const groups = new Map(); list.forEach(e => { const k = keyFn(e); (groups.get(k) || groups.set(k, []).get(k)).push(e); });
    let ents = [...groups.entries()];
    ents.sort(g === 'month' ? (a, b) => (a[1][0].date < b[1][0].date ? 1 : -1) : g === 'trip' ? (a, b) => (tripById(b[1][0].tripId)?.start || '').localeCompare(tripById(a[1][0].tripId)?.start || '') : (a, b) => byName(a[0], b[0]));  // months and trips: newest first; the rest: alphabetical
    S.groupKeys = ents.map(([k]) => g + '\u0001' + k);
    ents.forEach(([k, es]) => { const closed = S.collapsed.has(g + '\u0001' + k); items.push({ g: k, n: es.length, c: sumC(es), closed, label: g === 'category' ? `${catEmoji(k)} ${esc(k)}` : g === 'subcategory' ? `${catEmoji(es[0].category)} ${esc(es[0].category)} › ${es[0].subcategory ? emo(subEmoji(es[0].category, es[0].subcategory)) : ''}${esc(es[0].subcategory || '(None)')}` : g === 'trip' ? `🧳 ${esc(k)}` : esc(k) }); if (!closed) es.forEach(e => items.push({ e })); });
  }
  let shown = 0, rowsHtml = '';
  for (const it of items) {
    if (it.g !== undefined) { if (shown >= S.limit) break; rowsHtml += `<tr class="group" data-gkey="${esc(g + '\u0001' + it.g)}"><td colspan="5"><button type="button" class="grptoggle" aria-expanded="${!it.closed}" title="${it.closed ? 'Show' : 'Hide'} these entries"><span class="chev">${it.closed ? '▸' : '▾'}</span> ${it.label}</button> <span class="muted small">· ${it.n} entries · ${money(it.c, cur)}</span></td></tr>`; continue; }
    if (shown >= S.limit) break; shown++;
    const e = it.e;
    rowsHtml += `<tr class="row" tabindex="0" data-id="${esc(e.id)}">
      <td class="c-date">${fmtDate(e.date)}</td><td class="c-merchant">${esc(e.merchant)}</td>
      <td class="c-cat">${catEmoji(e.category)} ${esc(e.category)}${e.subcategory ? ` <span class="sub">› ${emo(subEmoji(e.category, e.subcategory))}${esc(e.subcategory)}</span>` : ''}</td>
      <td class="num c-amount ${e.amount < 0 ? 'neg' : ''}">${fmtMoney(e.amount, e.currency)}</td>
      <td class="c-rec">${detailsHtml(e)}</td></tr>`;
  }
  const rowCount = list.length, visibleRows = items.filter(it => it.e).length;
  const th = (k, label, cls = '') => `<th class="${cls}" aria-sort="${S.sort.key === k ? (S.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button data-sort="${k}">${label}${S.sort.key === k ? (S.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
  $('#cardTable').innerHTML = `${typeof tripHeaderHtml === 'function' ? tripHeaderHtml() : ''}<div class="toolbar"><div><h2>🧾 Expenses</h2><span class="muted small">${rowCount} ${rowCount === 1 ? 'entry' : 'entries'} · ${money(sumC(list), cur)} total · ${esc(periodLabel())}</span></div>
      <div class="grpctl">${g !== 'none' && rowCount ? '<button type="button" class="btn sm" id="grpCollapse">Collapse all</button><button type="button" class="btn sm" id="grpExpand">Expand all</button>' : ''}<label class="field" style="min-width:180px"><span>Group by</span><select id="fGroup">${[['none', 'No grouping'], ['category', 'Category'], ['subcategory', 'Subcategory'], ['merchant', 'Merchant'], ['month', 'Month']].concat(inTrips() ? [['trip', 'Trip']] : []).map(([v, l]) => `<option value="${v}" ${g === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div></div>
    ${rowCount ? `<div class="tablewrap"><table class="tx"><thead><tr>${th('date', 'Date')}${th('merchant', 'Merchant')}${th('category', 'Category')}${th('amount', 'Amount', 'num')}<th>Details</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      ${shown < visibleRows ? `<div class="empty"><button class="btn" id="btnMore">Show ${Math.min(100, visibleRows - shown)} more (${shown} of ${visibleRows} shown)</button></div>` : ''}`
      : emptyBox(inTrips() ? '🔍 No trip expenses match these filters. Assign expenses to a trip from an expense (Edit) or in the Data tab.' : S.doc.expenses.length ? '🔍 No expenses match this period and these filters.' : 'There are no expenses yet. Use “Add expense” to create one.')}`;
  saveUi();
}

/* ---------- dialogs ---------- */
function openDlg(d, html) {
  d.innerHTML = html;
  const h = d.querySelector('h2'); if (h) { h.id = h.id || d.id + 'Title'; d.setAttribute('aria-labelledby', h.id); }
  if (!d.open) d.showModal();
}
function closeDlg(d) { if (d.open) d.close(); }

/** Shows a receipt (image or PDF) in a window over the page, so nothing is left behind in another browser tab. */
function openReceipt(url) {
  const name = decodeURIComponent(url.split('/').pop()), d = $('#receiptDlg'), isPdf = /\.pdf$/i.test(name);
  const body = isPdf ? `<iframe src="${esc(url)}" title="${esc(name)}"></iframe>`
    : RC_PREVIEW.test(name) ? `<img src="${esc(url)}" alt="Receipt ${esc(name)}" class="fit" title="Click to zoom">`
    : `<p class="empty">This file type cannot be shown here.</p>`;
  d.innerHTML = `<div class="rchead"><strong>📎 ${esc(name)}</strong><span class="rcacts"><a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener" data-newtab>Open in a new tab ↗</a><button class="btn sm" data-close type="button">✕ Close</button></span></div><div class="rcbody">${body}</div>`;
  d.querySelector('img')?.addEventListener('click', ev => ev.currentTarget.classList.toggle('actual'));
  if (!d.open) d.showModal();
}
function toast(msg, err, action) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  if (action) { const b = document.createElement('button'); b.className = 'toastbtn'; b.textContent = action.label; b.onclick = () => { t.remove(); action.run(); }; t.appendChild(b); }
  $('#toast').appendChild(t); if (!action) hugText(t); setTimeout(() => t.remove(), action ? 12000 : err ? 6000 : 3000);
}
function confirmDlg({ title, body, ok = 'Confirm', danger = false }) {
  return new Promise(res => {
    const d = $('#confirmDlg');
    openDlg(d, `<div class="dlg-head"><h2>${esc(title)}</h2></div><div class="dlg-body"><p>${body}</p></div>
      <div class="dlg-foot"><button class="btn" data-r="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div>`);
    d.onclick = e => { const b = e.target.closest('[data-r]'); if (b) { d.onclose = null; closeDlg(d); res(b.dataset.r === '1'); } };
    d.onclose = () => res(false);
  });
}
function askText({ title, label, value = '', capital = true, allowEmpty = false }) {
  return new Promise(res => {
    const d = $('#askDlg');
    openDlg(d, `<form method="dialog" id="askForm"><div class="dlg-head"><h2>${esc(title)}</h2></div><div class="dlg-body">
      <label class="field"><span>${esc(label)}</span><input id="askInput" value="${esc(value)}" autocomplete="off" ${allowEmpty ? '' : 'required'}></label><div class="err" id="askErr"></div></div>
      <div class="dlg-foot"><button class="btn" type="button" data-r="0">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`);
    $('#askInput').select();
    let done = false;
    const finish = v => { if (done) return; done = true; closeDlg(d); res(v); };
    $('#askForm').onsubmit = e => { e.preventDefault(); const v = $('#askInput').value.trim(); if ((!v && !allowEmpty) || (capital && !/^\p{Lu}/u.test(v))) { $('#askErr').textContent = 'The name must start with an uppercase letter.'; return; } finish(v); };
    d.onclick = e => { if (e.target.closest('[data-r="0"]')) finish(null); };
    d.onclose = () => finish(null);
  });
}

function planHtml(e) {
  const list = S.doc.expenses.filter(x => x.installment?.groupId === e.installment.groupId).sort((a, b) => a.installment.index - b.installment.index);
  return `<table class="datatable" style="margin-top:6px"><tbody>${list.map(x => `<tr${x.id === e.id ? ' style="font-weight:600"' : ''}><td>${x.installment.index}/${x.installment.count}</td><td>${fmtDate(x.date)}</td><td>${fmtMoney(x.amount, x.currency)}</td></tr>`).join('')}</tbody></table>`;
}
function detailHtml(e) {
  const rf = e.receiptFile, isPdf = rf && !RC_PREVIEW.test(rf), url = rf ? '/receipts/' + encodeURIComponent(rf.replace(/^Receipts\//, '')) : '';
  return `<div class="dlg-head"><h2>${esc(e.merchant)}</h2><button class="btn ghost" data-close aria-label="Close">✕</button></div>
  <div class="dlg-body"><dl class="kv">
    <dt>Amount</dt><dd><strong>${fmtMoney(e.amount, e.currency)}</strong>${e.amount < 0 ? ' <span class="chip">↩️ Refund</span>' : ''}</dd>
    <dt>Date</dt><dd>${fmtDate(e.date)}</dd>
    <dt>Category</dt><dd>${catEmoji(e.category)} ${esc(e.category)}${e.subcategory ? ' › ' + emo(subEmoji(e.category, e.subcategory)) + esc(e.subcategory) : ''}</dd>
    <dt>Notes</dt><dd style="white-space:pre-wrap">${esc(e.notes) || '<span class="muted">—</span>'}</dd>
    ${tripById(e.tripId) ? `<dt>Trip</dt><dd>🧳 ${esc(tripById(e.tripId).name)} <span class="muted small">${esc(tripById(e.tripId).city)} · ${fmtDate(tripById(e.tripId).start)} – ${fmtDate(tripById(e.tripId).end)}</span></dd>` : ''}
    ${e.installment ? `<dt>Installment</dt><dd>${e.installment.index} of ${e.installment.count}${planHtml(e)}</dd>` : ''}
    <dt>Recorded on</dt><dd>${fmtDate(e.enteredDate)}</dd>
    <dt>Receipt ID</dt><dd>${esc(e.receiptId) || '<span class="muted">None</span>'}</dd>
    ${e.source?.origin === 'dashboard' ? '<dt>Source</dt><dd class="muted small">Added in the dashboard</dd>' : ''}</dl>
    ${rf ? `<div class="receipt">${isPdf ? `<div class="pad"><a href="${url}" target="_blank" rel="noopener">📎 Open receipt ↗</a></div>` : `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Receipt for ${esc(e.merchant)}" loading="lazy"></a>`}</div>` : ''}
  </div>
  <div class="dlg-foot">${e.installment ? '' : `<button class="btn danger" data-del="${esc(e.id)}">Delete</button>`}${e.installment ? `<button class="btn" data-editplan="${esc(e.id)}">Edit plan</button><button class="btn" data-merge="${esc(e.installment.groupId)}">Merge installments</button><button class="btn danger" data-delplan="${esc(e.installment.groupId)}">Delete all installments</button>` : `<button class="btn" data-split="${esc(e.id)}">Split into installments…</button>`}<button class="btn primary" data-edit="${esc(e.id)}">Edit</button></div>`;
}

let formState = null;
function openForm(e) {
  const d = S.doc, isNew = !e;
  const x = e || { date: new Date().toISOString().slice(0, 10), merchant: '', amount: '', currency: S.f.currency, category: '', subcategory: '', notes: '' };
  formState = { id: e?.id, initial: null, existing: e?.receiptFile || null, rc: { mode: 'keep', file: null, url: null } };
  const catOpts = `<option value="">Choose…</option>` + sortedCats(d).map(c => `<option ${c.name === x.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  openDlg($('#formDlg'), `<form id="expForm" novalidate><div class="dlg-head"><h2>${isNew ? 'Add expense' : 'Edit expense'}</h2><button type="button" class="btn ghost" data-cancel aria-label="Close">✕</button></div>
    <div class="dlg-body"><div class="formgrid">
      <label class="field"><span>Date</span><input type="date" name="date" value="${esc(x.date)}" required><div class="err" data-for="date"></div></label>
      <label class="field"><span>Amount (negative for a refund)</span><input name="amount" inputmode="decimal" value="${x.amount === '' ? '' : FMTR.input(x.amount)}" placeholder="0.00" required><div class="err" data-for="amount"></div></label>
      <label class="field full"><span>Merchant</span><input name="merchant" list="merchantListAll" value="${esc(x.merchant)}" required autocomplete="off"><div class="err" data-for="merchant"></div></label>
      <label class="field"><span>Category</span><select name="category">${catOpts}</select><div class="err" data-for="category"></div></label>
      <label class="field"><span>Subcategory</span><select name="subcategory"></select><div class="err" data-for="subcategory"></div></label>
      <label class="field"><span>Currency</span><input name="currency" value="${esc(x.currency)}" maxlength="3" style="text-transform:uppercase"><div class="err" data-for="currency"></div></label>
      <label class="field"><span>Trip</span><select name="tripId"><option value="">(None)</option>${[...(d.trips || [])].sort((a, b) => b.start.localeCompare(a.start)).map(t => `<option value="${esc(t.id)}" ${t.id === (x.tripId || (isNew ? tripOnDate(x.date)?.id : '')) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><div class="err" data-for="tripId"></div></label>
      <div class="field full"><span>Receipt (image or PDF, up to 25 MB)</span>
        <div class="uploader"><input type="file" id="rcFile" accept="image/*,.pdf,.heic,.heif,application/pdf" hidden>
          <button type="button" class="btn" id="rcPick">Choose file…</button><div id="rcBody"></div></div><div class="err" data-for="receipt"></div></div>
      <label class="field full"><span>Notes ${isNew ? '(write new notes in English)' : ''}</span><textarea name="notes">${esc(x.notes)}</textarea><div class="err" data-for="notes"></div></label>
    </div><div class="err" id="formErr" role="alert"></div></div>
    <div class="dlg-foot"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary" id="btnSave">${isNew ? 'Add expense' : 'Save changes'}</button></div></form>`);
  const f = $('#expForm');
  const fillSubs = () => { const c = d.categories.find(c => c.name === f.category.value); f.subcategory.innerHTML = `<option value="">(None)</option>` + (c ? sortedSubs(c) : []).map(s => `<option ${s === x.subcategory && f.category.value === x.category ? 'selected' : ''}>${esc(s)}</option>`).join(''); };
  fillSubs(); f.category.onchange = fillSubs;
  f.tripId.onchange = () => { f.tripId.dataset.touched = '1'; };
  f.date.onchange = () => { if (isNew && !f.tripId.dataset.touched) f.tripId.value = tripOnDate(f.date.value)?.id || ''; };
  renderUploader();
  formState.initial = snapshot();
}
function snapshot() { const r = formState.rc; return JSON.stringify([readForm(), r.mode, r.file?.name, r.file?.size]); }
function releaseRc() { if (formState?.rc?.url) URL.revokeObjectURL(formState.rc.url); }
function renderUploader() {
  const rc = formState.rc, cur = formState.existing, body = $('#rcBody'); if (!body) return;
  let html = '<div class="muted small">No receipt attached.</div>';
  if (rc.mode === 'new') {
    const f = rc.file;
    html = `<div class="rcline"><span><strong>${esc(f.name)}</strong> <span class="muted small">${fmtSize(f.size)}</span></span><button type="button" class="link" data-rc="clear">Remove</button></div>` +
      (RC_PREVIEW.test(f.name) ? `<img class="rcprev" src="${rc.url}" alt="Preview of the selected receipt">` : `<div class="muted small">${/\.pdf$/i.test(f.name) ? 'PDF file' : 'No preview in this browser; the file will still be saved.'}</div>`);
  } else if (rc.mode === 'keep' && cur) {
    html = `<div class="rcline"><span>Current: <a href="/receipts/${encodeURIComponent(cur.replace(/^Receipts\//, ''))}" target="_blank" rel="noopener">${esc(cur.replace(/^Receipts\//, ''))}</a></span><button type="button" class="link" data-rc="unlink">Remove receipt</button></div>`;
  } else if (rc.mode === 'remove') {
    html = `<div class="rcline"><span class="muted">The receipt will be unlinked from this expense (the file stays in Receipts/).</span><button type="button" class="link" data-rc="undo">Undo</button></div>`;
  }
  body.innerHTML = html;
  $('#rcPick').textContent = rc.mode === 'new' || (rc.mode === 'keep' && cur) ? 'Replace file…' : 'Choose file…';
}
function pickReceipt(file) {
  const err = document.querySelector('#expForm [data-for="receipt"]');
  err.textContent = '';
  if (!file) return;
  if (!RC_OK.test(file.name)) { err.textContent = 'Choose an image (JPG, PNG, WEBP, GIF, HEIC) or a PDF.'; return; }
  if (file.size > RC_MAX) { err.textContent = 'The file is larger than 25 MB.'; return; }
  releaseRc();
  formState.rc = { mode: 'new', file, url: RC_PREVIEW.test(file.name) ? URL.createObjectURL(file) : null };
  renderUploader();
}
async function uploadReceipt(file) {
  const r = await fetch('/api/receipts', { method: 'POST', headers: { 'X-Requested-With': 'expenses-ui', 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Upload failed (${r.status})`); e.status = r.status; e.details = []; throw e; }
  return j;
}
async function discardUpload(up) {
  if (up) try { await fetch('/api/receipts/' + encodeURIComponent(up.receiptFile.replace(/^Receipts\//, '')), { method: 'DELETE', headers: { 'X-Requested-With': 'expenses-ui' } }); } catch { /* best effort */ }
}
function readForm() {
  const f = $('#expForm'); if (!f) return {};
  return { date: f.date.value, merchant: f.merchant.value.trim(), amount: f.amount.value.trim(), currency: f.currency.value.trim().toUpperCase(), category: f.category.value, subcategory: f.subcategory.value, notes: f.notes.value, tripId: f.tripId.value };
}
function parseAmount(s) {
  const t = plainNumber(s);
  if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN;
  return Number(t);
}
function clientErrors(v) {
  const er = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || isNaN(new Date(v.date))) er.date = 'Enter a valid date.';
  if (!v.merchant) er.merchant = 'Merchant is required.';
  const a = parseAmount(v.amount);
  if (v.amount === '' || isNaN(a)) er.amount = 'Enter a number, for example 12.50 or -12.50.';
  else if (a === 0) er.amount = 'Amount cannot be zero.';
  else if (Math.abs(a * 100 - Math.round(a * 100)) > 1e-6) er.amount = 'Use at most 2 decimal places.';
  if (!/^[A-Z]{3}$/.test(v.currency)) er.currency = 'Use a 3-letter code such as EUR.';
  if (!v.category) er.category = 'Choose a category.';
  return er;
}
function showFormErrors(er, general) {
  document.querySelectorAll('#expForm [data-for]').forEach(n => { n.textContent = er[n.dataset.for] || ''; const i = n.parentElement.querySelector('input,select,textarea'); if (i) i.setAttribute('aria-invalid', er[n.dataset.for] ? 'true' : 'false'); });
  $('#formErr').textContent = general || '';
  const first = document.querySelector('#expForm [aria-invalid="true"]'); if (first) first.focus();
}
async function submitForm() {
  const v = readForm(), er = clientErrors(v);
  if (Object.keys(er).length) return showFormErrors(er, 'Please fix the highlighted fields.');
  const body = { expense: { ...v, amount: parseAmount(v.amount), tripId: v.tripId || null } };
  $('#btnSave').disabled = true;
  let up = null;
  try {
    if (formState.rc.mode === 'new') { up = await uploadReceipt(formState.rc.file); body.expense.receiptFile = up.receiptFile; body.expense.receiptId = up.receiptId; }
    else if (formState.rc.mode === 'remove') { body.expense.receiptFile = null; body.expense.receiptId = null; }
    if (formState.id) await api('PUT', '/expenses/' + formState.id, body);
    else {
      try { await api('POST', '/expenses', body); }
      catch (e) {
        if (e.status === 409 && e.details?.[0]?.duplicate) {
          if (!await confirmDlg({ title: 'Possible duplicate', body: 'An identical expense (same date, merchant, amount and category) already exists. Add it anyway?', ok: 'Add anyway' })) { await discardUpload(up); $('#btnSave').disabled = false; return; }
          await api('POST', '/expenses', { ...body, allowDuplicate: true });
        } else throw e;
      }
    }
    releaseRc(); formState = null; closeDlg($('#formDlg')); closeDlg($('#detail'));
    await loadData(false); toastUndo('Saved.');
  } catch (e) {
    await discardUpload(up);
    $('#btnSave').disabled = false;
    const map = {}; (e.details || []).forEach(d => { if (d.field) map[d.field] = d.message; });
    showFormErrors(map, e.status === 409 ? e.message + ' (Close this form and reload.)' : `Not saved: ${e.message}`);
  }
}
async function cancelForm() {
  if (formState && snapshot() !== formState.initial && !await confirmDlg({ title: 'Discard changes?', body: 'You have unsaved changes. If you close this form they will be lost.', ok: 'Discard', danger: true })) return;
  releaseRc(); formState = null; closeDlg($('#formDlg'));
}

async function deleteExpense(id) {
  const e = S.doc.expenses.find(x => x.id === id); if (!e) return;
  if (!await confirmDlg({ title: 'Delete this expense?', body: `<strong>${esc(e.merchant)}</strong> · ${fmtMoney(e.amount, e.currency)} · ${fmtDate(e.date)}<br>This cannot be undone from the dashboard (a backup of the previous data is kept in data/backups/).`, ok: 'Delete', danger: true })) return;
  try { await api('DELETE', '/expenses/' + id, {}); closeDlg($('#detail')); await loadData(false); toastUndo('Expense deleted.'); }
  catch (er) { toast(`Not deleted: ${er.message}`, true); }
}

/* categories manager */
const ROLE_LABELS = {
  bar_restaurant: 'Bar, restaurant, pub (home city)', cafe: 'Café, snack bar, fast food (home city)', groceries: 'Groceries & take-away bakery',
  alcohol: 'Alcohol bought to take away', toiletries: 'Toiletries', cleaning: 'Cleaning products', unclassified: 'Nothing fits',
  travel: 'Any expense while travelling', travel_bar_restaurant: 'Bar, restaurant, pub (travel)', travel_cafe: 'Café, snack bar, fast food (travel)',
  travel_groceries: 'Groceries & take-away bakery (travel)', travel_alcohol: 'Alcohol bought to take away (travel)',
  travel_vehicle: 'Taxi, ride-hailing, car rental, fuel (travel)', taxi: 'Taxi & ride-hailing in the home city, not airport',
};
function categoriesPanelHtml() {
  const d = S.doc;
  const used = (c, s) => d.expenses.filter(e => e.category === c && (s === undefined || e.subcategory === s)).length;
  return `<div class="panel-head"><p class="muted small" style="margin:0">Renaming updates every expense that uses the name. Names in use cannot be deleted until those expenses are moved. Changes can be undone from the Undo menu.</p><button class="btn sm" data-addcat>➕ Add category</button></div>
  <div class="catlist">
  ${sortedCats(d).map(c => `<div class="catitem"><div class="cathead"><strong>${c.emoji || '🏷️'} ${esc(c.name)}</strong> <span class="muted small">${used(c.name)} expenses</span>
    <span><button class="link" data-op="setEmoji" data-cat="${esc(c.name)}" title="Change the emoji">Emoji</button><button class="link" data-op="setHint" data-cat="${esc(c.name)}" title="${esc(c.hint || 'No description')}">${c.hint ? 'Description' : '+ Description'}</button><button class="link" data-op="renameCategory" data-cat="${esc(c.name)}">Rename</button><button class="link" data-op="deleteCategory" data-cat="${esc(c.name)}">Delete</button><button class="link" data-op="addSubcategory" data-cat="${esc(c.name)}">+ Subcategory</button></span></div>
    <div class="subs">${sortedSubs(c).map(s => `<span class="subchip"><button data-op="setSubEmoji" data-cat="${esc(c.name)}" data-sub="${esc(s)}" title="Change emoji" aria-label="Change emoji for ${esc(s)}">${c.subcategoryEmoji?.[s] || '◌'}</button>${esc(s)} <span class="muted small">${used(c.name, s)}</span><button data-op="setHint" data-cat="${esc(c.name)}" data-sub="${esc(s)}" title="${esc(c.subcategoryHints?.[s] || 'No description. Click to add one for the prompt.')}" aria-label="Description for ${esc(s)}"><span style="opacity:${c.subcategoryHints?.[s] ? 1 : .4}">ⓘ</span></button><button data-op="renameSubcategory" data-cat="${esc(c.name)}" data-sub="${esc(s)}" aria-label="Rename ${esc(s)}">✎</button><button data-op="deleteSubcategory" data-cat="${esc(c.name)}" data-sub="${esc(s)}" aria-label="Delete ${esc(s)}">✕</button></span>`).join('') || '<span class="muted small">No subcategories</span>'}</div></div>`).join('')}
  </div>`;
}
function promptRulesHtml() {
  const d = S.doc;
  return `<div class="catlist">${Object.entries(ROLE_LABELS).map(([k, label]) => { const r = d.promptRoles?.[k]; if (!r) return ''; const cat = d.categories.find(c => c.name === r.category);
    return `<div class="rolerow"><span>${esc(label)}</span><select data-rolecat="${k}" aria-label="${esc(label)} category">${sortedCats(d).map(c => `<option ${c.name === r.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <select data-rolesub="${k}" aria-label="${esc(label)} subcategory">${(k === 'travel' ? ['<option value="">(Whole category)</option>'] : []).join('')}${(cat ? sortedSubs(cat) : []).map(x => `<option ${x === r.subcategory ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>`; }).join('')}</div>`;
}
async function catOp(body) {
  try { const j = await api('POST', '/categories', body); await loadData(false); if (j.promptWarning) toast(j.promptWarning, true); else toastUndo('Saved. Prompt file updated.'); }
  catch (e) { toast(e.message, true); }
}


/* ---------- events ---------- */
function setMode(mode) {
  S.f.mode = mode;
  if (mode === 'custom' && !S.f.from) { const r = periodRange({ ...S.f, mode: 'month' }); S.f.from = r[0]; S.f.to = r[1]; }
  S.limit = 100; renderAll();
}
function step(n) {
  const f = S.f;
  if (f.mode === 'year') f.year += n;
  else { f.month += n; if (f.month < 1) { f.month = 12; f.year--; } if (f.month > 12) { f.month = 1; f.year++; } }
  S.limit = 100; renderAll();
}
function refreshBody() { S.limit = 100; renderSummary(); renderCats(); renderTrend(); renderTable(); renderControls(); if (typeof renderExtras === 'function') renderExtras(); }

document.addEventListener('click', async ev => {
  const t = ev.target;
  const c = sel => t.closest(sel);
  const rl = c('a[href^="/receipts/"]');
  if (rl) {   // a receipt opens in a window over this page; Cmd/Ctrl/Shift-click or the middle button still opens a new tab
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0 || rl.dataset.newtab !== undefined) return;
    ev.preventDefault(); return openReceipt(rl.getAttribute('href'));
  }
  if (c('#btnUndo')) return toggleUndoMenu();
  if (c('[data-undo]')) return doUndo(c('[data-undo]').dataset.undo, { confirm: false });
  if (!c('.undowrap')) toggleUndoMenu(false);
  if (c('#btnRetry')) return loadData(true);
  if (c('#modeSeg button')) return setMode(c('#modeSeg button').dataset.mode);
  if (c('[data-step]')) return step(+c('[data-step]').dataset.step);
  if (c('#btnClear')) { Object.assign(S.f, { q: '', category: '', subcategory: '', merchant: '' }); $('#fSearch').value = ''; $('#fMerchant').value = ''; return refreshBody(); }
  if (c('[data-trip]') && typeof openTrip === 'function') return openTrip(c('[data-trip]').dataset.trip);
  if (c('#btnAdd')) return S.doc ? openForm(null) : null;
  if (c('#btnMore')) { S.limit += 200; return renderTable(); }
  if (c('#grpCollapse')) { (S.groupKeys || []).forEach(k => S.collapsed.add(k)); return renderTable(); }
  if (c('#grpExpand')) { S.collapsed.clear(); return renderTable(); }
  const gr = c('tr.group[data-gkey]'); if (gr) { const k = gr.dataset.gkey; S.collapsed.has(k) ? S.collapsed.delete(k) : S.collapsed.add(k); return renderTable(); }
  if (c('#btnTrendTable')) { S.showTrendTable = !S.showTrendTable; return renderTrend(); }
  if (c('[data-sort]')) { const k = c('[data-sort]').dataset.sort; S.sort = { key: k, dir: S.sort.key === k && S.sort.dir === 'desc' ? 'asc' : 'desc' }; renderTable(); if (typeof D !== 'undefined' && D.tab === 'data') renderData(); return; }
  if (c('[data-toggle]')) { const k = c('[data-toggle]').dataset.toggle; S.expanded.has(k) ? S.expanded.delete(k) : S.expanded.add(k); return renderCats(); }
  if (c('[data-catsort]')) { S.catSort = S.catSort === 'alpha' ? 'amount' : 'alpha'; return renderCats(); }
  if (c('[data-expandall]')) { S.expanded = c('[data-expandall]').dataset.expandall === '1' ? new Set(S.doc.categories.map(x => x.name)) : new Set(); return renderCats(); }
  if (c('[data-filtercat]')) { const k = c('[data-filtercat]').dataset.filtercat; const on = S.f.category === k && !S.f.subcategory; Object.assign(S.f, { category: on ? '' : k, subcategory: '' }); return refreshBody(); }
  if (c('[data-filtersub]')) { const b = c('[data-filtersub]'), on = S.f.category === b.dataset.cat && S.f.subcategory === b.dataset.filtersub; Object.assign(S.f, on ? { category: '', subcategory: '' } : { category: b.dataset.cat, subcategory: b.dataset.filtersub }); return refreshBody(); }
  if (c('[data-month]')) { const m = c('[data-month]').dataset.month; Object.assign(S.f, { mode: 'month', year: +m.slice(0, 4), month: +m.slice(5) }); return renderAll(); }
  if (c('tr.row')) return showDetail(c('tr.row').dataset.id);
  if (c('[data-close]')) return closeDlg(c('dialog'));
  if (c('[data-edit]')) { const e = S.doc.expenses.find(x => x.id === c('[data-edit]').dataset.edit); return openForm(e); }
  if (c('[data-del]')) return deleteExpense(c('[data-del]').dataset.del);
  if (c('[data-cancel]')) return cancelForm();
  if (c('[data-copyprompt]')) {
    try { const t = await (await fetch('/api/prompt', { cache: 'no-store' })).text(); await navigator.clipboard.writeText(t); toast('Prompt copied.'); }
    catch { toast('Could not copy. Open data/receipt-prompt.md instead.', true); }
    return;
  }
  if (c('[data-addcat]')) { const n = await askText({ title: 'Add category', label: 'Category name' }); if (n) catOp({ op: 'addCategory', name: n }); return; }
  const op = c('[data-op]');
  if (op) {
    const { op: o, cat, sub } = op.dataset;
    if (o === 'renameCategory') { const n = await askText({ title: 'Rename category', label: 'New name', value: cat }); if (n && n !== cat) catOp({ op: o, category: cat, name: n }); }
    else if (o === 'addSubcategory') { const n = await askText({ title: `Add subcategory to ${cat}`, label: 'Subcategory name' }); if (n) catOp({ op: o, category: cat, name: n }); }
    else if (o === 'setHint') {
      const c0 = S.doc.categories.find(x => x.name === cat), cur = sub ? (c0.subcategoryHints?.[sub] || '') : (c0.hint || '');
      const n = await askText({ title: `Description for ${sub || cat}`, label: 'When should the prompt use this? (English, leave empty to remove)', value: cur, capital: false, allowEmpty: true });
      if (n !== null && n !== cur) catOp({ op: o, category: cat, subcategory: sub || '', hint: n });
    }
    else if (o === 'setSubEmoji') {
      const n = await askText({ title: `Emoji for ${sub}`, label: 'One emoji (leave empty to remove)', value: S.doc.categories.find(x => x.name === cat)?.subcategoryEmoji?.[sub] || '', capital: false, allowEmpty: true });
      if (n !== null) catOp({ op: o, category: cat, subcategory: sub, emoji: n });
    }
    else if (o === 'setEmoji') {
      const n = await askText({ title: `Emoji for ${cat}`, label: 'One emoji (leave empty for the default 🏷️)', value: S.doc.categories.find(x => x.name === cat)?.emoji || '', capital: false, allowEmpty: true });
      if (n !== null) catOp({ op: o, category: cat, emoji: n });
    }
    else if (o === 'renameSubcategory') { const n = await askText({ title: 'Rename subcategory', label: 'New name', value: sub }); if (n && n !== sub) catOp({ op: o, category: cat, subcategory: sub, name: n }); }
    else if (await confirmDlg({ title: 'Delete?', body: `Delete <strong>${esc(sub || cat)}</strong>?`, ok: 'Delete', danger: true })) catOp({ op: o, category: cat, subcategory: sub });
  }
});
document.addEventListener('mouseover', ev => {   // highlight everything an undo would revert
  const it = ev.target.closest('.undoitem'); const items = document.querySelectorAll('.undoitem');
  items.forEach(x => x.classList.toggle('willundo', !!it && +x.dataset.i <= +it.dataset.i));
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && !$('#undoMenu').hidden) { toggleUndoMenu(false); $('#btnUndo').focus(); }
  if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'z') {
    const t = ev.target, typing = t.matches?.('input, textarea, select, [contenteditable]');
    if (!typing && !document.querySelector('dialog[open]') && S.history.length) { ev.preventDefault(); doUndo(S.history[0].id); }
  }
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('tr.row')) { ev.preventDefault(); showDetail(ev.target.dataset.id); }
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[data-trip], [data-tripsel]')) { ev.preventDefault(); ev.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[data-month]')) { ev.preventDefault(); ev.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
});
document.addEventListener('change', ev => {
  const t = ev.target, f = S.f;
  if (t.id === 'pMonth') f.month = +t.value; else if (t.id === 'pYear') f.year = +t.value;
  else if (t.id === 'pFrom') f.from = t.value; else if (t.id === 'pTo') f.to = t.value;
  else if (t.id === 'fCategory') { f.category = t.value; f.subcategory = ''; }
  else if (t.id === 'fSub') { if (t.value.includes('\u0001')) { [f.category, f.subcategory] = t.value.split('\u0001'); } else f.subcategory = t.value; }
  else if (t.id === 'fCurrency') f.currency = t.value;
  else if (t.dataset.rolecat) { const c = S.doc.categories.find(x => x.name === t.value); catOp({ op: 'setRole', role: t.dataset.rolecat, category: t.value, subcategory: t.dataset.rolecat === 'travel' ? '' : (sortedSubs(c)[0] || '') }); return; }
  else if (t.dataset.rolesub !== undefined) { catOp({ op: 'setRole', role: t.dataset.rolesub, category: t.closest('.rolerow').querySelector('[data-rolecat]').value, subcategory: t.value }); return; }
  else if (t.id === 'fGroup') { if (inTrips()) S.tripsGroup = t.value; else S.group = t.value; S.collapsed.clear(); return renderTable(); }
  else return;
  refreshBody();
});
let debounce;
document.addEventListener('input', ev => {
  const t = ev.target;
  if (t.id !== 'fSearch' && t.id !== 'fMerchant') return;
  clearTimeout(debounce);
  debounce = setTimeout(() => { S.f[t.id === 'fSearch' ? 'q' : 'merchant'] = t.value.trim(); refreshBody(); }, 150);
});
document.addEventListener('change', ev => { if (ev.target.id === 'rcFile') { pickReceipt(ev.target.files[0]); ev.target.value = ''; } });
document.addEventListener('click', ev => {
  if (ev.target.closest('#rcPick')) return $('#rcFile').click();
  const b = ev.target.closest('[data-rc]'); if (!b || !formState) return;
  const a = b.dataset.rc;
  if (a === 'clear' || a === 'undo') { releaseRc(); formState.rc = { mode: 'keep', file: null, url: null }; }
  if (a === 'unlink') formState.rc = { mode: 'remove', file: null, url: null };
  renderUploader();
});
document.addEventListener('submit', ev => { if (ev.target.id === 'expForm') { ev.preventDefault(); submitForm(); } });
document.addEventListener('cancel', ev => { if (ev.target.id === 'formDlg') { ev.preventDefault(); cancelForm(); } }, true);

/* Clicking outside the details drawer closes it (the form dialog keeps asking, so edits are never lost by accident). */
document.addEventListener('click', ev => {
  const d = ev.target;
  if (!d || (d.id !== 'detail' && d.id !== 'receiptDlg') || !d.open) return;
  const r = d.getBoundingClientRect();
  if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) closeDlg(d);
});

function showDetail(id) { const e = S.doc.expenses.find(x => x.id === id); if (e) openDlg($('#detail'), detailHtml(e)); }

/* tooltip */
const tip = $('#tip');
function hugText(el) {
  // A wrapped box keeps the width of its longest possible line, leaving empty space on the right.
  // Shrink it to the widest line that is actually drawn.
  el.style.width = 'max-content';
  const r = document.createRange(); r.selectNodeContents(el);
  const rects = [...r.getClientRects()].filter(x => x.width > 0);
  if (!rects.length) return;
  const cs = getComputedStyle(el), pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const text = Math.max(...rects.map(x => x.right)) - Math.min(...rects.map(x => x.left));
  el.style.width = Math.ceil(text + pad + 1) + 'px';
}
function placeTip(ev) {
  tip.style.left = '0px'; tip.style.top = '0px';   // measure at full available width, then move
  hugText(tip);
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY + 16;
  if (x + w > innerWidth - 8) x = Math.max(8, ev.clientX - w - 14);   // near the right edge: show on the left of the pointer
  if (y + h > innerHeight - 8) y = Math.max(8, ev.clientY - h - 12);  // near the bottom: show above the pointer
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
document.addEventListener('mouseover', ev => { const t = ev.target.closest('[data-tip]'); if (!t) { tip.hidden = true; return; } tip.textContent = t.dataset.tip; tip.hidden = false; placeTip(ev); });
document.addEventListener('mousemove', ev => { if (!tip.hidden) placeTip(ev); });
document.addEventListener('scroll', () => { tip.hidden = true; }, true);

window.addEventListener('focus', () => { if (S.doc && !document.querySelector('dialog[open]') && !(typeof D !== 'undefined' && D.pending.size)) loadData(false); });
loadData(true);

/* app version (from the VERSION file), shown before the byline */
fetch('/api/version', { cache: 'no-store' }).then(r => r.json()).then(j => {
  if (j.version) { const el = $('#appVersion'); el.textContent = `v${j.version} · `; el.title = 'See CHANGELOG.md for what changed'; }
}).catch(() => {});

/* The server imports receipts left in the Inbox. Check every 20 seconds and refresh when something new arrived. */
setInterval(async () => {
  if (document.hidden || !S.doc || S.loading || document.querySelector('dialog[open]') || (typeof D !== 'undefined' && D.pending.size) || formState) return;
  try {
    const j = await (await fetch('/api/inbox', { cache: 'no-store' })).json();
    if (j.revision === undefined || j.revision === S.doc.revision) return;
    const before = S.history[0]?.id;
    await loadData(false);
    const top = S.history[0];
    if (top && top.id !== before && /^Imported|from the inbox/.test(top.label)) toastUndo(top.label + '.');
  } catch { /* the server may be restarting */ }
}, 20000);

