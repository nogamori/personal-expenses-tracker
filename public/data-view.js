'use strict';
/* Data tab (spreadsheet-style bulk editing), installments and scheduled payments. Loaded after app.js and shares its globals. */

const D = { tab: 'dash', pending: new Map(), sel: new Set(), limit: 150, changedOnly: false, review: '', last: null, shown: [], total: 0, schedAll: false };
const byId = id => S.doc.expenses.find(e => e.id === id);
const localToday = () => new Date().toLocaleDateString('en-CA');
const curVal = (id, f) => { const p = D.pending.get(id); return p && f in p ? p[f] : byId(id)[f]; };

function renderExtras() { renderSched(); if (D.tab === 'data') renderData(); if (typeof renderSettings === 'function') renderSettings(); }

/* ---------- tabs ---------- */
async function setTab(tab) {
  if (tab === D.tab) return;
  if (D.tab === 'data' && D.pending.size) {
    if (!await confirmDlg({ title: 'Leave with unsaved changes?', body: `${D.pending.size} edited ${D.pending.size === 1 ? 'row is' : 'rows are'} not saved. Discard the changes?`, ok: 'Discard', danger: true })) return;
    D.pending.clear();
  }
  D.tab = tab; D.changedOnly = false; D.review = ''; D.limit = 150; D.sel.clear();
  document.body.removeAttribute('data-reviewing');
  $('#dashView').hidden = tab !== 'dash' && tab !== 'trips'; $('#dataView').hidden = tab !== 'data'; $('#settingsView').hidden = tab !== 'settings';
  document.body.dataset.view = tab; window.scrollTo(0, 0);
  document.querySelectorAll('.viewtabs [data-tab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  if (tab === 'data') renderData();
  if (tab === 'dash' || tab === 'trips') { S.limit = 100; renderAll(); }   // the same page, with or without the trip scope
  if (tab === 'settings' && typeof renderSettings === 'function') renderSettings();
  if (typeof saveUi === 'function') saveUi();
}

/* ---------- Data grid ---------- */
/** Expenses to check against the trips list: dated inside a trip but not assigned to it, or Travel with no trip at all. */
function reviewSets() {
  const ex = S.doc.expenses;
  return { inTrip: ex.filter(e => !e.tripId && tripOnDate(e.date)), outTrip: ex.filter(e => e.category === 'Travel' && !e.tripId && !tripOnDate(e.date)) };
}
function dataList() {
  if (D.review) return sortedList(reviewSets()[D.review]);
  const list = D.changedOnly ? S.doc.expenses.filter(e => D.pending.has(e.id)) : select(periodRange());
  return sortedList(list);
}
function rowHtml(e, cats) {
  const p = D.pending.get(e.id) || {}, v = f => (f in p ? p[f] : e[f]), d = f => (f in p ? ' dirty' : '');
  const cat = cats.find(c => c.name === v('category')), id = esc(e.id);
  return `<tr data-id="${id}" class="${D.sel.has(e.id) ? 'selected' : ''}">
    <td class="c-sel"><input type="checkbox" class="rowsel" ${D.sel.has(e.id) ? 'checked' : ''} aria-label="Select row"></td>
    <td><input type="date" data-f="date" class="${d('date')}" value="${esc(v('date'))}"></td>
    <td><input data-f="merchant" list="merchantListAll" class="${d('merchant')}" value="${esc(v('merchant'))}" autocomplete="off"></td>
    <td><select data-f="category" class="${d('category')}">${cats.map(c => `<option ${c.name === v('category') ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></td>
    <td><select data-f="subcategory" class="${d('subcategory')}">${subOptions(cat, v('subcategory'))}</select></td>
    <td><input data-f="amount" class="num${d('amount')}" inputmode="decimal" value="${FMTR.input(v('amount'))}"></td>
    <td><input data-f="notes" class="${d('notes')}" value="${esc(v('notes'))}" autocomplete="off"></td>
    <td><select data-f="tripId" class="${d('tripId')}">${tripOptions(v('tripId'))}</select></td>
    <td class="c-flags">${detailsHtml(e, false)}</td></tr>`;
}
const tripOptions = sel => `<option value="">(None)</option>` + [...(S.doc.trips || [])].sort((a, b) => b.start.localeCompare(a.start)).map(t => `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
const subOptions = (cat, sel) => `<option value="">(None)</option>` + (cat ? sortedSubs(cat) : []).map(s => `<option ${s === sel ? 'selected' : ''}>${esc(s)}</option>`).join('');

function renderData() {
  if (!S.doc || D.tab !== 'data') return;
  document.body.toggleAttribute('data-reviewing', !!D.review);   // a review ignores the period, so the period bar is hidden
  const list = dataList(), shown = list.slice(0, D.limit), cats = sortedCats(S.doc);
  D.shown = shown.map(e => e.id); D.total = list.length;
  const th = (k, label, cls = '') => `<th class="${cls}" aria-sort="${S.sort.key === k ? (S.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button data-sort="${k}">${label}${S.sort.key === k ? (S.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;
  $('#dataView').innerHTML = `<div id="dataBar" class="databar"></div>
    ${list.length ? `<div class="tablewrap"><table class="grid"><thead><tr><th class="c-sel"><input type="checkbox" id="selAll" aria-label="Select all shown rows"></th>${th('date', 'Date')}${th('merchant', 'Merchant')}${th('category', 'Category')}<th>Subcategory</th>${th('amount', 'Amount', 'num')}<th>Notes</th><th>Trip</th><th>Details</th></tr></thead>
      <tbody>${shown.map(e => rowHtml(e, cats)).join('')}</tbody></table></div>
      ${shown.length < list.length ? `<div class="empty"><button class="btn" id="dataMore">Show ${Math.min(150, list.length - shown.length)} more (${shown.length} of ${list.length} shown)</button></div>` : ''}`
      : emptyBox(D.changedOnly ? '🔍 No changed rows.' : D.review ? '✅ Nothing to review here.' : '🔍 No expenses match this period and these filters.')}`;
  renderDataBar();
}
function renderDataBar() {
  const bar = $('#dataBar'); if (!bar) return;
  const n = D.pending.size, sel = D.sel.size, dis = sel ? '' : 'disabled title="Select rows first"';
  bar.innerHTML = `<div><h2>🗂️ Data</h2><span class="muted small">${D.total} rows · ${D.review ? 'trip review, all dates' : esc(periodLabel())} · ${sel} selected</span></div>
    <div class="dbtools">
      <button class="btn sm" data-bulk="merchant" ${dis}>Set merchant…</button>
      <button class="btn sm" data-bulk="category" ${dis}>Set category…</button>
      <button class="btn sm" data-bulk="trip" ${dis} title="Assign the selected rows to the trip that contains their date">🧳 Assign to trip</button>
      <button class="btn sm" data-bulk="replace">Find &amp; replace…</button>
      <button class="btn sm" data-bulk="cleanup">Clean up merchant names…</button>
</div>
    <div class="dbsave"><select id="reviewMode" aria-label="Trip review"><option value="">Review: off</option><option value="inTrip" ${D.review === 'inTrip' ? 'selected' : ''}>🧳 Dated during a trip, not assigned to one (${reviewSets().inTrip.length})</option><option value="outTrip" ${D.review === 'outTrip' ? 'selected' : ''}>✈️ Travel outside any trip (${reviewSets().outTrip.length})</option></select>
      <label class="small"><input type="checkbox" id="changedOnly" ${D.changedOnly ? 'checked' : ''}> Changed rows only</label>
      <span class="${n ? 'pendingbadge' : 'muted small'}">${n ? `${n} unsaved ${n === 1 ? 'row' : 'rows'}` : 'No unsaved changes'}</span>
      <button class="btn sm" data-bulk="discard" ${n ? '' : 'disabled'}>Discard</button>
      <button class="btn sm primary" data-bulk="save" ${n ? '' : 'disabled'}>Save changes</button></div>`;
}

/* ---------- staging edits (nothing is saved until "Save changes") ---------- */
function parseDateInput(s) {
  s = s.trim(); let m;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isNaN(new Date(s)) ? null : s;
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/))) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; const iso = FMTR.monthFirst ? isoDate(y, +m[1], +m[2]) : isoDate(y, +m[2], +m[1]); return isNaN(new Date(iso)) || new Date(iso).getUTCDate() !== +m[1] ? null : iso; }
  if ((m = s.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/))) { const mi = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()); return mi < 0 ? null : isoDate(+m[3], mi + 1, +m[1]); }
  return null;
}
function setPending(id, f, value) {
  const e = byId(id), p = D.pending.get(id) || {}, orig = f === 'tripId' ? (e.tripId ?? null) : e[f];
  if (value === orig) delete p[f]; else p[f] = value;
  if (Object.keys(p).length) D.pending.set(id, p); else D.pending.delete(id);
}
/** Returns an error message, or null when the edit was staged. */
function stage(id, f, raw) {
  const e = byId(id); if (!e) return 'Row not found.';
  let value = raw;
  if (f === 'merchant') { value = raw.trim(); if (!value) return 'Merchant cannot be empty.'; }
  else if (f === 'notes') value = raw.replace(/\s+$/, '');
  else if (f === 'date') { value = parseDateInput(raw); if (!value) return `“${raw}” is not a valid date.`; }
  else if (f === 'amount') {
    const a = parseAmount(String(raw).trim());
    if (isNaN(a) || a === 0 || Math.abs(a * 100 - Math.round(a * 100)) > 1e-6) return `“${raw}” is not a valid amount.`;
    value = Math.round(a * 100) / 100;
  } else if (f === 'category') {
    const c = S.doc.categories.find(c => c.name.toLowerCase() === String(raw).trim().toLowerCase());
    if (!c) return `Unknown category “${raw}”.`;
    value = c.name;
  } else if (f === 'subcategory') {
    const c = S.doc.categories.find(c => c.name === curVal(id, 'category'));
    const s = String(raw).trim() === '' ? '' : c.subcategories.find(x => x.toLowerCase() === String(raw).trim().toLowerCase());
    if (s === undefined) return `“${raw}” is not a subcategory of ${c.name}.`;
    value = s;
  } else if (f === 'tripId') {
    value = raw || null; if (value && !tripById(value)) return 'Unknown trip.';
  } else return 'This field cannot be edited here.';
  setPending(id, f, value);
  if (f === 'category') {  // a subcategory from another category no longer applies
    const c = S.doc.categories.find(c => c.name === value), sub = curVal(id, 'subcategory');
    if (sub && !c.subcategories.includes(sub)) setPending(id, 'subcategory', '');
  }
  return null;
}
function refreshRow(tr) {
  const id = tr.dataset.id, p = D.pending.get(id) || {};
  tr.querySelectorAll('[data-f]').forEach(inp => {
    const f = inp.dataset.f, dirty = f in p;
    inp.classList.toggle('dirty', dirty);
    if (f === 'subcategory') { const cat = S.doc.categories.find(c => c.name === curVal(id, 'category')); inp.innerHTML = subOptions(cat, curVal(id, 'subcategory')); }
    else if (document.activeElement !== inp) inp.value = f === 'amount' ? FMTR.input(curVal(id, f)) : (curVal(id, f) ?? '');
  });
  renderDataBar();
}
function applyMany(f, value, ids = [...D.sel]) {
  let bad = 0, first = null;
  ids.forEach(id => { const err = stage(id, f, value); if (err) { bad++; first = first || err; } });
  renderData();
  toast(bad ? `${ids.length - bad} rows updated, ${bad} skipped (${first})` : `${ids.length} ${ids.length === 1 ? 'row' : 'rows'} updated. Review them, then press “Save changes”.`, bad > 0 && bad === ids.length);
}

/* ---------- saving, with undo ---------- */
async function saveChanges() {
  const updates = [...D.pending].map(([id, set]) => ({ id, set }));
  try {
    await api('POST', '/expenses/batch', { updates });
    D.pending.clear(); D.changedOnly = false;
    await loadData(false);
    toastUndo(`Saved ${updates.length} ${updates.length === 1 ? 'row' : 'rows'}.`);
  } catch (e) {
    toast(`Not saved: ${e.message}${e.details?.[0]?.message ? ' — ' + e.details[0].message : ''}`, true);
  }
}

/* ---------- bulk tools ---------- */
function toolDlg(title, body, foot) {
  openDlg($('#toolDlg'), `<div class="dlg-head"><h2>${esc(title)}</h2><button class="btn ghost" data-close aria-label="Close">✕</button></div><div class="dlg-body">${body}</div><div class="dlg-foot">${foot}</div>`);
}
function categoryTool() {
  const cats = sortedCats(S.doc);
  toolDlg(`Set category for ${D.sel.size} rows`, `<div class="formgrid">
    <label class="field"><span>Category</span><select id="tCat">${cats.map(c => `<option>${esc(c.name)}</option>`).join('')}</select></label>
    <label class="field"><span>Subcategory</span><select id="tSub"></select></label></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="tApply">Apply</button>`);
  const fill = () => { $('#tSub').innerHTML = subOptions(cats.find(c => c.name === $('#tCat').value), ''); };
  fill(); $('#tCat').onchange = fill;
  $('#tApply').onclick = () => { const ids = [...D.sel]; closeDlg($('#toolDlg')); applyMany('category', $('#tCat').value, ids); applyMany('subcategory', $('#tSub').value, ids); };
}
function replaceTool() {
  const sel = D.sel.size;
  toolDlg('Find & replace', `<div class="formgrid">
    <label class="field"><span>In</span><select id="rField"><option value="merchant">Merchant</option><option value="notes">Notes</option></select></label>
    <label class="field"><span>Apply to</span><select id="rScope"><option value="view">All ${D.total} rows in this view</option>${sel ? `<option value="sel" selected>${sel} selected rows</option>` : ''}</select></label>
    <label class="field"><span>Find</span><input id="rFind" autocomplete="off"></label>
    <label class="field"><span>Replace with</span><input id="rWith" autocomplete="off"></label>
    <label class="small full"><input type="checkbox" id="rCase"> Match case</label></div><p class="muted small" id="rInfo">Type something to find.</p>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rApply" disabled>Replace</button>`);
  const matches = () => {
    const find = $('#rFind').value; if (!find) return [];
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $('#rCase').checked ? 'g' : 'gi'), f = $('#rField').value;
    const ids = $('#rScope').value === 'sel' ? [...D.sel] : dataList().map(e => e.id);
    return ids.filter(id => re.test(curVal(id, f)) && ((re.lastIndex = 0), true)).map(id => ({ id, f, to: curVal(id, f).replace(re, () => $('#rWith').value) }));
  };
  const upd = () => { const m = matches(); $('#rInfo').textContent = $('#rFind').value ? `${m.length} ${m.length === 1 ? 'row matches' : 'rows match'}.` : 'Type something to find.'; $('#rApply').disabled = !m.length; };
  ['#rField', '#rScope', '#rFind', '#rWith', '#rCase'].forEach(s => { $(s).oninput = upd; $(s).onchange = upd; });
  $('#rApply').onclick = () => {
    const m = matches(); let bad = 0; m.forEach(x => { if (stage(x.id, x.f, x.to)) bad++; });
    closeDlg($('#toolDlg')); renderData();
    toast(bad ? `${m.length - bad} rows updated, ${bad} skipped.` : `${m.length} rows updated. Review them, then press “Save changes”.`, bad === m.length);
  };
}
function similarGroups() {
  const key = m => m.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[0-9#*]+/g, ' ').replace(/[^a-z& ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/( (s a u|s l u|s a|s l|s p a|sau|slu|sa|sl|ltd|lda|llc|inc|gmbh|sas|srl|spa|bv))+$/, '');
  const byKey = new Map();
  S.doc.expenses.forEach(e => { const k = key(e.merchant); if (!k) return; const g = byKey.get(k) || new Map(); const m = curVal(e.id, 'merchant'); g.set(m, (g.get(m) || 0) + 1); byKey.set(k, g); });
  const keys = [...byKey.keys()];
  const roots = keys.filter(k => !keys.some(a => a !== k && k.startsWith(a + ' ')));
  return roots.map(r => {
    const members = keys.filter(k => k === r || k.startsWith(r + ' '));
    const all = new Map();
    members.forEach(k => byKey.get(k).forEach((n, name) => all.set(name, (all.get(name) || 0) + n)));
    return { all, loose: members.length > 1 };
  }).filter(g => g.all.size > 1).map(g => {
    const variants = [...g.all.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => (/\d/.test(a.name) - /\d/.test(b.name)) || b.n - a.n || a.name.length - b.name.length);
    return { variants, target: variants[0].name, total: variants.reduce((s, v) => s + v.n, 0), loose: g.loose };
  }).sort((a, b) => (a.loose - b.loose) || b.total - a.total);
}
function cleanupTool() {
  const groups = similarGroups();
  toolDlg('Clean up merchant names', groups.length ? `<p class="muted small">Names that look like the same merchant (they differ only by numbers, accents or a company ending such as S.A. or S.L.). Groups marked <em>possible match</em> are names where one starts with the other (for example “Rossmann” and “Rossmann Drogueria”); they are not selected until you tick them. Check the groups to merge and edit the target name if needed. Nothing is saved until you press “Save changes”.</p>
    <div class="catlist">${groups.map((g, i) => `<div class="catitem"><label class="cathead"><span><input type="checkbox" data-grp="${i}" ${g.loose ? '' : 'checked'}> <strong>${g.total} rows</strong>${g.loose ? ' <span class="muted small">· possible match</span>' : ''}</span>
      <input class="grpname" data-tgt="${i}" value="${esc(g.target)}" aria-label="Target name"></label>
      <div class="muted small" style="margin-top:6px">${g.variants.map(v => `${esc(v.name)} (${v.n})`).join(' · ')}</div></div>`).join('')}</div>`
    : '<p class="empty">No similar merchant names found.</p>',
    `<button class="btn" data-close>Cancel</button>${groups.length ? '<button class="btn primary" id="cApply">Rename selected groups</button>' : ''}`);
  if (!groups.length) return;
  $('#cApply').onclick = () => {
    let rows = 0;
    groups.forEach((g, i) => {
      if (!$(`[data-grp="${i}"]`).checked) return;
      const target = $(`[data-tgt="${i}"]`).value.trim(); if (!target) return;
      const names = new Set(g.variants.map(v => v.name));
      S.doc.expenses.forEach(e => { if (names.has(curVal(e.id, 'merchant')) && curVal(e.id, 'merchant') !== target && !stage(e.id, 'merchant', target)) rows++; });
    });
    closeDlg($('#toolDlg')); D.changedOnly = true; D.limit = 150; renderData();
    toast(`${rows} rows renamed. Review them, then press “Save changes”.`);
  };
}

/* ---------- Data tab events ---------- */
document.addEventListener('click', async ev => {
  const t = ev.target, c = s => t.closest(s);
  if (c('.viewtabs [data-tab]')) return setTab(c('.viewtabs [data-tab]').dataset.tab);
  if (c('#dataMore')) { D.limit += 300; return renderData(); }
  const cb = c('.rowsel');
  if (cb) {
    const id = cb.closest('tr').dataset.id, i = D.shown.indexOf(id);
    const ids = ev.shiftKey && D.last !== null ? D.shown.slice(Math.min(i, D.last), Math.max(i, D.last) + 1) : [id];
    ids.forEach(x => cb.checked ? D.sel.add(x) : D.sel.delete(x)); D.last = i;
    document.querySelectorAll('#dataView tbody tr').forEach(tr => { tr.classList.toggle('selected', D.sel.has(tr.dataset.id)); tr.querySelector('.rowsel').checked = D.sel.has(tr.dataset.id); });
    return renderDataBar();
  }
  const b = c('[data-bulk]'); if (!b || b.disabled) return;
  const a = b.dataset.bulk;
  if (a === 'merchant') { const n = await askText({ title: `Set merchant for ${D.sel.size} rows`, label: 'New merchant name', capital: false }); if (n) applyMany('merchant', n); }
  else if (a === 'category') categoryTool();
  else if (a === 'trip') {
    let n = 0, none = 0;
    D.sel.forEach(id => { const t = tripOnDate(curVal(id, 'date')); if (!t) { none++; return; } if (!stage(id, 'tripId', t.id)) n++; });
    renderData();
    toast(n ? `${n} ${n === 1 ? 'row' : 'rows'} assigned to a trip${none ? `; ${none} not inside any trip` : ''}. Review them, then press “Save changes”.` : 'None of the selected rows is dated inside a trip.', !n);
  }
  else if (a === 'replace') replaceTool();
  else if (a === 'cleanup') cleanupTool();
  else if (a === 'discard') { D.pending.clear(); D.changedOnly = false; renderData(); }
  else if (a === 'save') saveChanges();
});
document.addEventListener('change', ev => {
  const t = ev.target; if (!t.closest?.('#dataView')) return;
  if (t.id === 'reviewMode') { D.review = t.value; D.limit = 150; D.sel.clear(); return renderData(); }
  if (t.id === 'changedOnly') { D.changedOnly = t.checked; D.limit = 150; return renderData(); }
  if (t.id === 'selAll') { D.shown.forEach(id => t.checked ? D.sel.add(id) : D.sel.delete(id)); return renderData(); }
  if (!t.dataset.f) return;
  const err = stage(t.closest('tr').dataset.id, t.dataset.f, t.value);
  if (err) { toast(err, true); t.value = t.dataset.f === 'amount' ? FMTR.input(curVal(t.closest('tr').dataset.id, 'amount')) : curVal(t.closest('tr').dataset.id, t.dataset.f); }
  refreshRow(t.closest('tr'));
});
window.addEventListener('beforeunload', ev => { if (D.pending.size) { ev.preventDefault(); ev.returnValue = ''; } });

/* ---------- Installments ---------- */
function addMonthsIso(iso, k) {
  const [y, m, d] = iso.split('-').map(Number), t = (m - 1) + k, yy = y + Math.floor(t / 12), mm = ((t % 12) + 12) % 12 + 1;
  return isoDate(yy, mm, Math.min(d, new Date(yy, mm, 0).getDate()));
}
function planFor(totalCents, n, first) {
  const base = Math.floor(totalCents / n), r = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => ({ date: addMonthsIso(first, i), amount: FMTR.input((base + (i < r ? 1 : 0)) / 100) }));
}
function installmentsTool(id, editPlan = false) {
  const e0 = byId(id), plan = editPlan ? S.doc.expenses.filter(x => x.installment?.groupId === e0.installment.groupId).sort((a, b) => a.installment.index - b.installment.index) : [e0];
  const e = editPlan ? plan[0] : e0, sign = e.amount < 0 ? -1 : 1, total = editPlan ? plan.reduce((s, x) => s + Math.round(Math.abs(x.amount) * 100), 0) : Math.round(Math.abs(e.amount) * 100);
  const P = editPlan ? { n: plan.length, first: plan[0].date, rows: plan.map(x => ({ date: x.date, amount: FMTR.input(Math.abs(x.amount)) })) } : { n: 6, first: e.date, rows: [] };
  if (!editPlan) P.rows = planFor(total, P.n, P.first);
  toolDlg(editPlan ? 'Edit installment plan' : 'Split into installments', `<p class="muted small">${editPlan ? `${esc(e.merchant)} · ${plan.length} installments · ${fmtMoney(sign * total / 100, e.currency)} in total · bought on ${fmtDate(e.installment.purchaseDate || e.date)}. Change the number, the dates and the amounts; changing the number or the first date fills the rows in again.` : `${esc(e.merchant)} · ${fmtMoney(e.amount, e.currency)} · bought on ${fmtDate(e.date)}. The purchase becomes one entry per installment, each in the month it is paid.`}</p>
    <div class="formgrid"><label class="field"><span>Number of installments</span><input id="iN" type="number" min="2" max="120" value="${P.n}"></label>
    <label class="field"><span>First payment date</span><input id="iFirst" type="date" value="${esc(P.first)}"></label></div>
    <div id="iRows"></div><p class="small" id="iSum"></p><div class="err" id="iErr" role="alert"></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="iApply">${editPlan ? 'Save plan' : 'Split purchase'}</button>`);
  const sumCents = () => P.rows.reduce((s, r) => s + Math.round((parseAmount(String(r.amount)) || 0) * 100), 0);
  const draw = () => {
    $('#iRows').innerHTML = `<table class="datatable"><thead><tr><th>#</th><th>Date</th><th class="num">Amount</th></tr></thead><tbody>${P.rows.map((r, i) => `<tr><td>${i + 1}/${P.rows.length}</td>
      <td><input type="date" data-ir="${i}" data-k="date" value="${esc(r.date)}"></td><td class="num"><input data-ir="${i}" data-k="amount" class="num" inputmode="decimal" value="${esc(r.amount)}"></td></tr>`).join('')}</tbody></table>`;
    sum();
  };
  const sum = () => {
    const s = sumCents(), diff = s - total;
    $('#iSum').innerHTML = `Total of installments: <strong>${fmtMoney(sign * s / 100, e.currency)}</strong> · ${diff === 0 ? `<span class="muted">matches the ${editPlan ? 'current total' : 'purchase'}</span>` : `<span style="color:var(--danger)">differs from the ${editPlan ? 'current total' : 'purchase'} by ${fmtMoney(diff / 100, e.currency)} (interest or fees?)</span>`}`;
  };
  const regen = () => { const n = Math.max(2, Math.min(120, parseInt($('#iN').value, 10) || 2)); P.n = n; P.first = $('#iFirst').value || e.date; P.rows = planFor(total, n, P.first); draw(); };
  $('#iN').onchange = regen; $('#iFirst').onchange = regen;
  $('#iRows').oninput = ev => { const i = ev.target.dataset.ir; if (i === undefined) return; P.rows[i][ev.target.dataset.k] = ev.target.value; sum(); };
  draw();
  $('#iApply').onclick = async () => {
    const items = [];
    for (const [i, r] of P.rows.entries()) {
      const a = parseAmount(String(r.amount));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || isNaN(a) || a <= 0 || Math.abs(a * 100 - Math.round(a * 100)) > 1e-6) { $('#iErr').textContent = `Installment ${i + 1} needs a valid date and a positive amount with at most 2 decimals.`; return; }
      items.push({ date: r.date, amount: sign * Math.round(a * 100) / 100 });
    }
    if (sumCents() !== total && !await confirmDlg({ title: 'Totals differ', body: `The installments add up to ${fmtMoney(sign * sumCents() / 100, e.currency)}, not ${fmtMoney(sign * total / 100, e.currency)}. ${editPlan ? 'Save anyway' : 'Split anyway'}?`, ok: editPlan ? 'Save anyway' : 'Split anyway' })) return;
    try { await api('POST', editPlan ? '/installments/replace' : '/installments', editPlan ? { groupId: e.installment.groupId, installments: items } : { expenseId: id, installments: items }); closeDlg($('#toolDlg')); closeDlg($('#detail')); await loadData(false); toastUndo(editPlan ? `Plan updated: ${items.length} installments.` : `Split into ${items.length} installments.`); }
    catch (er) { $('#iErr').textContent = er.message; }
  };
}
async function mergeInstallments(groupId) {
  const list = S.doc.expenses.filter(e => e.installment?.groupId === groupId);
  const total = list.reduce((s, e) => s + cents(e.amount), 0), e0 = list[0];
  if (!await confirmDlg({ title: 'Merge installments?', body: `The ${list.length} installments of <strong>${esc(e0.merchant)}</strong> become one purchase of <strong>${money(total, e0.currency)}</strong> on ${fmtDate(e0.installment.purchaseDate || list.map(x => x.date).sort()[0])}.`, ok: 'Merge' })) return;
  try { await api('POST', '/installments/merge', { groupId }); closeDlg($('#detail')); await loadData(false); toastUndo('Installments merged back into one purchase.'); }
  catch (er) { toast(er.message, true); }
}
async function deleteInstallmentPlan(groupId) {
  const list = S.doc.expenses.filter(e => e.installment?.groupId === groupId).sort((a, b) => a.date.localeCompare(b.date));
  const total = list.reduce((s, e) => s + cents(e.amount), 0), e0 = list[0];
  if (!await confirmDlg({ title: 'Delete all installments?', body: `All <strong>${list.length}</strong> installments of <strong>${esc(e0.merchant)}</strong> (${money(total, e0.currency)} in total, ${fmtDate(e0.date)} to ${fmtDate(list[list.length - 1].date)}) are deleted. You can undo it from the Undo menu.`, ok: 'Delete all', danger: true })) return;
  try { await api('POST', '/installments/delete', { groupId }); closeDlg($('#detail')); await loadData(false); toastUndo(`${list.length} installments deleted.`); }
  catch (er) { toast(er.message, true); }
}
document.addEventListener('click', ev => {
  const s = ev.target.closest('[data-split]'), m = ev.target.closest('[data-merge]'), p = ev.target.closest('[data-delplan]'), ep = ev.target.closest('[data-editplan]');
  if (s) installmentsTool(s.dataset.split);
  if (ep) installmentsTool(ep.dataset.editplan, true);
  if (m) mergeInstallments(m.dataset.merge);
  if (p) deleteInstallmentPlan(p.dataset.delplan);
});

/* ---------- Scheduled (future-dated) payments ---------- */
function renderSched() {
  const el = $('#cardSched'); if (!el || !S.doc) return;
  if (inTrips()) { el.hidden = true; return; }
  const cur = S.f.currency, today = localToday();
  const future = S.doc.expenses.filter(e => e.currency === cur && e.date > today);
  if (!future.length) { el.hidden = true; return; }
  el.hidden = false;
  const by = new Map();
  future.forEach(e => { const k = e.date.slice(0, 7), o = by.get(k) || { c: 0, n: 0 }; o.c += cents(e.amount); o.n++; by.set(k, o); });
  const months = [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), total = sumC(future), max = Math.max(1, ...months.map(([, o]) => Math.abs(o.c)));
  const shown = D.schedAll ? months : months.slice(0, 8);
  el.innerHTML = `<div class="card-head"><h2>🗓️ Scheduled payments</h2><span class="crumbs">after today</span></div>
    <p class="small" style="margin:0 0 8px"><strong>${money(total, cur)}</strong> <span class="muted">in ${future.length} ${future.length === 1 ? 'payment' : 'payments'} through ${fmtMonth(months[months.length - 1][0])}</span></p>
    <div class="schedlist">${shown.map(([k, o]) => `<button type="button" class="schedrow" data-schedmonth="${k}" data-tip="${esc(`${fmtMonth(k)}: ${money(o.c, cur)} (${o.n} ${o.n === 1 ? 'entry' : 'entries'}). Click to open this month.`)}">
      <span>${fmtMonth(k)}</span><span class="bartrack"><span class="barfill" style="width:${Math.abs(o.c) / max * 100}%"></span></span><span class="barval">${money(o.c, cur)}</span></button>`).join('')}</div>
    ${months.length > 8 ? `<button class="link small" data-schedall>${D.schedAll ? 'Show fewer months' : `Show all ${months.length} months`}</button>` : ''}`;
}
document.addEventListener('click', ev => {
  const m = ev.target.closest('[data-schedmonth]');
  if (m) { const k = m.dataset.schedmonth; if (D.tab !== 'dash') setTab('dash'); Object.assign(S.f, { mode: 'month', year: +k.slice(0, 4), month: +k.slice(5) }); renderAll(); }
  if (ev.target.closest('[data-schedall]')) { D.schedAll = !D.schedAll; renderSched(); }
});

/* keep the Data grid's sticky column headers just below the sticky page header */
(() => {
  const bar = $('.topbar'), set = () => document.documentElement.style.setProperty('--topbar-h', bar.getBoundingClientRect().height + 'px');
  set(); new ResizeObserver(set).observe(bar);
})();
