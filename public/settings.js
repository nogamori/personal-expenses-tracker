'use strict';
/* Settings: categories, how totals work, receipt prompt, data & storage and about. Loaded after data-view.js. */

const ST = { section: 'categories' };
const SECTIONS = [['categories', '🏷️', 'Categories'], ['trips', '🧳', 'Home & trips'], ['totals', 'ℹ️', 'How totals work'], ['prompt', '🤖', 'Receipt prompt'], ['data', '💾', 'Data & storage'], ['about', '✨', 'About']];
const getJson = async p => (await fetch(p, { cache: 'no-store' })).json();
const getText = async p => (await fetch(p, { cache: 'no-store' })).text();

function renderSettings() {
  const el = $('#settingsView'); if (!el || D.tab !== 'settings' || !S.doc) return;
  el.innerHTML = `<div class="settings"><nav class="setnav" aria-label="Settings sections">${SECTIONS.map(([k, i, l]) =>
    `<button type="button" data-section="${k}" aria-current="${ST.section === k}">${i} ${l}</button>`).join('')}</nav><div class="setbody" id="setBody"></div></div>`;
  renderSection();
}

function renderSection() {
  const b = $('#setBody'); if (!b) return;
  ({ categories: secCategories, trips: secTrips, totals: secTotals, prompt: secPrompt, data: secData, about: secAbout }[ST.section])(b);
}

function secCategories(b) {
  b.innerHTML = `<h2>🏷️ Categories &amp; subcategories</h2>${categoriesPanelHtml()}`;
}

function secTrips(b) {
  const d = S.doc;
  const rv = reviewSets();
  b.innerHTML = `<h2>🧳 Home &amp; trips</h2>
    <h3>Home city</h3>
    <p class="muted small">Anything bought outside your home city, including a day trip, counts as a trip. The receipt prompt uses this city.</p>
    <div class="homeform"><label class="field"><span>Home city</span><input id="homeCity" value="${esc(d.settings?.homeCity || '')}" maxlength="80" autocomplete="off"></label><button class="btn" id="saveHome">Save</button></div>
    <h3>Trips</h3>
    <p class="muted small" style="max-width:62ch">Trips are listed and managed in the <button class="link" data-gotrips>🧳 Trips tab</button>. The receipt prompt lists them, so a receipt scanned after you are back still lands on the right one. A trip is not the same as the Travel category: a purchase made on a trip keeps its own category.</p>
    <p class="small">${rv.inTrip.length ? `🧳 <strong>${rv.inTrip.length}</strong> expenses are dated inside a trip but not assigned to it.` : '✅ Every expense dated inside a trip is assigned.'}
      ${rv.outTrip.length ? `✈️ ${rv.outTrip.length} Travel expenses are outside any trip (flights and hotels booked in advance are normal).` : ''}
      <button class="link" data-review>Review in the Data tab</button></p>`;
}

function tripDialog(id) {
  const t = id ? tripById(id) : { name: '', city: '', country: '', start: localToday(), end: localToday() };
  toolDlg(id ? 'Edit trip' : 'Add trip', `<div class="formgrid">
    <label class="field full"><span>Name</span><input id="tName" value="${esc(t.name)}" maxlength="80" placeholder="Lisbon, September 2026" autocomplete="off"></label>
    <label class="field"><span>City</span><input id="tCity" value="${esc(t.city)}" maxlength="80" autocomplete="off"></label>
    <label class="field"><span>Country (optional)</span><input id="tCountry" value="${esc(t.country || '')}" maxlength="80" autocomplete="off"></label>
    <label class="field"><span>First day</span><input id="tStart" type="date" value="${esc(t.start)}"></label>
    <label class="field"><span>Last day</span><input id="tEnd" type="date" value="${esc(t.end)}"></label></div>
    <p class="muted small">Include the days of travel itself, for example the airport on departure day.</p><div class="err" id="tErr" role="alert"></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="tSave">Save</button>`);
  $('#tSave').onclick = async () => {
    const trip = { name: $('#tName').value.trim(), city: $('#tCity').value.trim(), country: $('#tCountry').value.trim(), start: $('#tStart').value, end: $('#tEnd').value };
    if (!trip.name || !trip.city) return void ($('#tErr').textContent = 'Enter a name and a city.');
    if (!trip.start || !trip.end || trip.start > trip.end) return void ($('#tErr').textContent = 'Choose valid dates, with the first day on or before the last.');
    try { await api('POST', '/trips', id ? { op: 'updateTrip', id, trip } : { op: 'addTrip', trip }); closeDlg($('#toolDlg')); await loadData(false); toastUndo(id ? 'Trip saved.' : 'Trip added.'); }
    catch (e) { $('#tErr').textContent = e.message; }
  };
}

/** Groups Travel expenses that are not covered by any trip into candidate trips (gaps of up to 4 days). */
function suggestTrips() {
  const ex = S.doc.expenses.filter(e => e.category === 'Travel' && !e.tripId && !tripOnDate(e.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const groups = []; let cur = [];
  ex.forEach(e => { if (cur.length && daysBetween(cur[cur.length - 1].date, e.date) - 1 > 4) { groups.push(cur); cur = []; } cur.push(e); });
  if (cur.length) groups.push(cur);
  if (!groups.length) return toast('Every Travel expense is already inside a trip.');
  const stop = /^(Purchase|Booking|Order|Item|Items|Receipt|Invoice|Payment|Ticket|Airport|Dinner|Lunch)\b/;
  const guess = g => { const c = {}; g.forEach(e => { const m = e.notes.match(/^\s*(\p{Lu}[\p{L}'’\- ]{2,28}?)\s*[,;]/u); if (m && !stop.test(m[1])) c[m[1]] = (c[m[1]] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || ''; };
  const rows = groups.map(g => { const city = guess(g), a = g[0].date, z = g[g.length - 1].date; return { city, start: a, end: z, n: g.length, total: sumC(g), name: `${city || 'Trip'} ${MONTHS[+a.slice(5, 7) - 1]} ${a.slice(0, 4)}` }; });
  toolDlg('Suggested trips', `<p class="muted small">Groups of Travel expenses that are not inside any trip yet. Untick the ones that are not trips (for example flights booked in advance), fix the names and places, then add them. Nothing is assigned to a trip until you do it in the Data tab.</p>
    <div class="catlist">${rows.map((r, i) => `<div class="catitem"><label class="cathead"><span><input type="checkbox" data-sg="${i}" ${r.n > 1 || r.city ? 'checked' : ''}> <strong>${r.n} ${r.n === 1 ? 'expense' : 'expenses'}</strong> · ${money(r.total, S.f.currency)}</span></label>
      <div class="formgrid" style="margin-top:8px"><label class="field full"><span>Name</span><input data-sn="${i}" value="${esc(r.name)}"></label>
      <label class="field"><span>City</span><input data-sc="${i}" value="${esc(r.city)}" placeholder="City"></label><span></span>
      <label class="field"><span>First day</span><input type="date" data-ss="${i}" value="${r.start}"></label><label class="field"><span>Last day</span><input type="date" data-se="${i}" value="${r.end}"></label></div></div>`).join('')}</div><div class="err" id="sErr" role="alert"></div>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="sApply">Add selected trips</button>`);
  $('#sApply').onclick = async () => {
    const trips = rows.map((r, i) => ({ on: $(`[data-sg="${i}"]`).checked, name: $(`[data-sn="${i}"]`).value.trim(), city: $(`[data-sc="${i}"]`).value.trim(), country: '', start: $(`[data-ss="${i}"]`).value, end: $(`[data-se="${i}"]`).value })).filter(t => t.on);
    if (!trips.length) return void ($('#sErr').textContent = 'Tick at least one trip.');
    if (trips.some(t => !t.name || !t.city || !t.start || !t.end || t.start > t.end)) return void ($('#sErr').textContent = 'Every selected trip needs a name, a city and valid dates.');
    try { await api('POST', '/trips', { op: 'addTrips', trips: trips.map(({ on, ...t }) => t) }); closeDlg($('#toolDlg')); await loadData(false); toastUndo(`${trips.length} ${trips.length === 1 ? 'trip' : 'trips'} added. Open the Data tab to assign expenses to them.`); }
    catch (e) { $('#sErr').textContent = e.message; }
  };
}

document.addEventListener('click', async ev => {
  const c = s => ev.target.closest(s);
  if (c('#saveHome')) {
    try { await api('POST', '/trips', { op: 'setHomeCity', city: $('#homeCity').value }); await loadData(false); toastUndo('Home city saved.'); } catch (e) { toast(e.message, true); }
  }
  if (c('#addTrip')) tripDialog();
  if (c('#suggestTrips')) suggestTrips();
  if (c('[data-edittrip]')) tripDialog(c('[data-edittrip]').dataset.edittrip);
  if (c('[data-deltrip]')) {
    const t = tripById(c('[data-deltrip]').dataset.deltrip), n = S.doc.expenses.filter(e => e.tripId === t.id).length;
    if (await confirmDlg({ title: 'Delete this trip?', body: `<strong>${esc(t.name)}</strong>${n ? `<br>${n} ${n === 1 ? 'expense is' : 'expenses are'} assigned to it. They stay, but are no longer linked to a trip.` : ''}`, ok: 'Delete', danger: true })) {
      try { await api('POST', '/trips', { op: 'deleteTrip', id: t.id }); await loadData(false); toastUndo('Trip deleted.'); } catch (e) { toast(e.message, true); }
    }
  }
  if (c('[data-review]')) { const rv = reviewSets(); await setTab('data'); D.review = rv.inTrip.length ? 'inTrip' : 'outTrip'; renderData(); }
});

function secTotals(b) {
  b.innerHTML = `<h2>ℹ️ How totals work</h2><div class="info">
    <p><strong>Total spent</strong> is the sum of every expense dated inside the selected period that matches your search, category, subcategory and merchant filters. Refunds (negative amounts) are subtracted, and the card says how much they reduced the total.</p>
    <ul>
      <li><strong>Dates.</strong> An expense counts in the month of its date. Each installment counts in the month it is paid, so a purchase split in 6 spreads over 6 months.</li>
      <li><strong>Previous period.</strong> The comparison on the Total spent card uses the whole previous month or year, or, for a custom range, the same number of days right before it. A month that is still in progress therefore looks lower. “All time” has no comparison.</li>
      <li><strong>Scheduled payments.</strong> Entries dated after today (for example later installments). They are also counted in the total of their own month.</li>
      <li><strong>Spending by category.</strong> A category’s percentage is its share of Total spent; a subcategory’s percentage is its share of its own category. The ▼ marks the amount in the previous period. Bars are scaled to the largest category, and subcategory bars to their category.</li>
      <li><strong>Monthly trend.</strong> Ignores the selected period so you can see context, but respects every other filter. Click a bar to open that month.</li>
      <li><strong>Currencies.</strong> Currencies are never added together or converted, and no exchange rates are used. With a single currency (today: EUR) there is nothing to choose. If expenses in another currency appear, a Currency filter shows up and every total and chart then uses the selected currency.</li>
      <li><strong>Trips.</strong> A trip is a named range of days (managed in the Trips tab). Expenses assigned to a trip show a 🧳; the assigned count and total are listed per trip. A purchase made on a trip does not have to be in the Travel category.</li>
      <li><strong>Data tab.</strong> Lists the same expenses as the dashboard, for the same period and filters. Edits there are saved only when you press “Save changes”.</li>
      <li><strong>Undo.</strong> The Undo menu keeps the last 10 saved actions, so a mistaken edit or delete can be reversed.</li>
    </ul></div>`;
}

async function secPrompt(b) {
  b.innerHTML = `<h2>🤖 Receipt prompt</h2>
    <p class="muted small">The instructions your phone automation (a Shortcut, Tasker, a script…) gives to the model when it reads a receipt. It is rebuilt automatically from your categories and from the rules below, every time they change. The file is <code>data/receipt-prompt.md</code>; edit the template (<code>prompts/receipt-prompt.template.md</code>) to change the wording.</p>
    <div class="panel-head"><h3 style="margin:0">Rules</h3><button class="btn sm" data-copyprompt>📋 Copy prompt</button></div>
    <p class="muted small">The prompt refers to these categories by role. Renaming a category updates them automatically; to delete a category used here, point the rule elsewhere first.</p>
    ${promptRulesHtml()}
    <h3>Preview</h3><pre class="preview" id="promptPreview">Loading…</pre>`;
  try { $('#promptPreview').textContent = await getText('/api/prompt'); } catch { $('#promptPreview').textContent = 'The prompt file could not be loaded.'; }
}

const fmtStamp = iso => { if (!iso) return '—'; const d = new Date(iso); return `${fmtDate(d.toLocaleDateString('en-CA'))} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

async function secData(b) {
  b.innerHTML = '<h2>💾 Data &amp; storage</h2><div class="skeleton" style="width:50%"></div><div class="skeleton"></div>';
  let a, ib = {}; try { [a, ib] = await Promise.all([getJson('/api/about'), getJson('/api/inbox')]); } catch { b.innerHTML = '<h2>💾 Data &amp; storage</h2><p class="muted">Could not load the information. Is the server running?</p>'; return; }
  if (ST.section !== 'data') return;
  const c = a.counts;
  b.innerHTML = `<h2>💾 Data &amp; storage</h2>
    <dl class="kv wide">
      <dt>Expenses</dt><dd>${c.expenses}</dd>
      <dt>Categories</dt><dd>${c.categories} categories, ${c.subcategories} subcategories</dd>
      <dt>Receipts</dt><dd>${c.receiptsLinked} linked to expenses · ${c.receiptFiles} files in the folder${c.filesNotLinked ? ` · ${c.filesNotLinked} not linked` : ''}</dd>
      <dt>Last saved</dt><dd>${esc(fmtStamp(a.updatedAt))} (revision ${a.revision})</dd>
      <dt>Backups</dt><dd>${a.backups} automatic backups kept · ${a.historyActions} actions in the Undo history</dd>
      <dt>Data format</dt><dd>schema version ${a.schemaVersion}</dd></dl>
    <h3>Where your files are</h3>
    <dl class="kv wide paths"><dt>Data</dt><dd><code>${esc(a.paths.data)}</code></dd><dt>Receipts</dt><dd><code>${esc(a.paths.receipts)}</code></dd>
      <dt>Backups</dt><dd><code>${esc(a.paths.backups)}</code></dd><dt>Prompt</dt><dd><code>${esc(a.paths.prompt)}</code></dd></dl>
    <p class="muted small">Everything stays on this computer, in this folder. Nothing is sent anywhere.</p>
    <h3>Receipt inbox</h3>
    <p class="muted small">Your phone automation leaves one small file per receipt in <code>Inbox/</code>. The server imports it within about 20 seconds (it keeps the file in <code>Inbox/Processed/</code>) and the import can be undone. Files it cannot read go to <code>Inbox/Failed/</code> with an explanation.</p>
    <dl class="kv wide"><dt>Waiting</dt><dd>${ib.pending ?? 0} ${ib.pending ? '<span class="muted small">(a file waits up to 10 minutes for its receipt image to finish syncing)</span>' : ''}</dd>
      <dt>Last import</dt><dd>${ib.last ? `${esc(fmtStamp(ib.last.at))} · ${ib.last.imported} imported${ib.last.edits ? `, ${ib.last.edits} changes from the phone` : ''}, ${ib.last.skipped} skipped as duplicates` : '<span class="muted">None since the server started</span>'}</dd>
      <dt>Rejected</dt><dd>${(ib.failed || []).length ? ib.failed.map(f => `${esc(f.file)} <span class="muted small">— ${esc(f.error)}</span>`).join('<br>') : '<span class="muted">None</span>'}</dd></dl>
    <button class="btn" id="importNow">📥 Import now</button>
    <h3>Integrity check</h3>
    <p class="muted small">Checks the data format, unique ids, that every linked receipt file exists, and that no full card number is stored in notes.</p>
    <button class="btn" id="runCheck">✅ Run integrity check</button><div id="checkOut" aria-live="polite"></div>`;
}

async function secAbout(b) {
  b.innerHTML = '<h2>✨ About</h2><div class="skeleton" style="width:50%"></div><div class="skeleton"></div>';
  let a, log = '';
  try { [a, log] = await Promise.all([getJson('/api/about'), getText('/api/changelog')]); } catch { b.innerHTML = '<h2>✨ About</h2><p class="muted">Could not load the information.</p>'; return; }
  if (ST.section !== 'about') return;
  b.innerHTML = `<h2>✨ About</h2>
    <dl class="kv wide"><dt>App</dt><dd><strong>Personal Expenses</strong> by <a href="https://github.com/nogamori/personal-expenses-tracker" target="_blank" rel="noopener noreferrer">nogamori</a></dd>
      <dt>Version</dt><dd><strong>v${esc(a.version || '?')}</strong> <span class="chip">beta</span></dd>
      <dt>Data format</dt><dd>schema version ${a.schemaVersion}</dd>
      <dt>Server</dt><dd>Python ${esc(a.python)} · started ${esc(fmtStamp(a.startedAt))}</dd>
      <dt>Privacy</dt><dd>Runs only on this computer, with no accounts and no external services.</dd></dl>
    <h3>What changed</h3><pre class="preview" tabindex="0" aria-label="Changelog">${esc(log) || 'No changelog found.'}</pre>`;
}

document.addEventListener('click', async ev => {
  const sec = ev.target.closest('[data-section]');
  if (sec) { ST.section = sec.dataset.section; if (typeof saveUi === 'function') saveUi(); document.querySelectorAll('.setnav button').forEach(x => x.setAttribute('aria-current', String(x === sec))); return renderSection(); }
  if (ev.target.closest('#importNow')) {
    try {
      const r = await (await fetch('/api/inbox/import', { method: 'POST', headers: { 'X-Requested-With': 'expenses-ui', 'Content-Type': 'application/json' }, body: '{}' })).json();
      await loadData(false);
      toast(r.imported ? `Imported ${r.imported} ${r.imported === 1 ? 'expense' : 'expenses'}.` : r.failed?.length ? `${r.failed.length} file(s) could not be read.` : 'Nothing new in the inbox.', !!r.failed?.length && !r.imported);
    } catch { toast('The import could not run.', true); }
  }
  if (ev.target.closest('#runCheck')) {
    const out = $('#checkOut'); out.innerHTML = '<div class="skeleton" style="width:40%"></div>';
    try {
      const r = await getJson('/api/check'), bad = r.checks.filter(c => !c.ok);
      out.innerHTML = `<ul class="checklist">${r.checks.map(c => `<li>${c.ok ? '✅' : '⚠️'} ${esc(c.name)}${c.detail ? ` <span class="muted small">— ${esc(c.detail)}</span>` : ''}</li>`).join('')}</ul>
        <p class="small ${bad.length ? '' : 'muted'}">${bad.length ? `${bad.length} ${bad.length === 1 ? 'check needs' : 'checks need'} attention.` : 'Everything looks fine.'}</p>`;
    } catch { out.innerHTML = '<p class="muted">The check could not run.</p>'; }
  }
});
