'use strict';
/* Trips tab. It is the Dashboard (summary, categories, expenses table, the filters in the header) limited to the expenses assigned to a trip,
   with no period: with no trip selected it shows the expenses of every trip, grouped by trip. app.js does the scoping (inTrips, S.tripSel);
   this file draws the trips card, the header of the selected trip and opens a trip from the 🧳 of an expense. Trips are created, edited and
   deleted from here (the dialogs live in settings.js). Loaded after settings.js and shares its globals. */

const T = { q: '' };
const sortedTrips = () => [...(S.doc.trips || [])].sort((a, b) => b.start.localeCompare(a.start));

function renderTripsCard() {
  const el = $('#cardTrips');
  if (!el) return;
  el.hidden = !inTrips();
  if (!inTrips() || !S.doc) return;
  const cur = S.f.currency, q = searchWords(T.q), trips = sortedTrips();
  const filtered = !!(S.f.q || S.f.category || S.f.subcategory || S.f.merchant);
  const rowsOf = t => S.doc.expenses.filter(e => e.tripId === t.id && matchesBase(e, { ignoreTrip: true }));
  const items = trips.map(t => ({ t, rows: rowsOf(t) }))
    .filter(x => searchMatch(q, [x.t.name, x.t.city, x.t.country || '']) && (!filtered || x.rows.length));
  const allRows = items.flatMap(x => x.rows);
  let year = '', html = `<div class="tripitem ${S.tripSel ? '' : 'selected'}" role="button" tabindex="0" data-tripsel=""><div class="nm">🧳 All trips</div><div class="amt">${money(sumC(allRows), cur)}</div>
      <div class="meta">${items.length} ${items.length === 1 ? 'trip' : 'trips'} · ${allRows.length} ${allRows.length === 1 ? 'expense' : 'expenses'}</div></div>`;
  items.forEach(({ t, rows }) => {
    const y = t.start.slice(0, 4);
    if (y !== year) { year = y; html += `<div class="tripyear">${y}</div>`; }
    html += `<div class="tripitem ${rows.length ? '' : 'dim'} ${t.id === S.tripSel ? 'selected' : ''}" role="button" tabindex="0" data-tripsel="${esc(t.id)}">
      <div class="nm">${esc(t.name)}</div><div class="amt">${rows.length ? money(sumC(rows), cur) : '—'}</div>
      <div class="meta">${fmtDate(t.start)}${t.end !== t.start ? ' – ' + fmtDate(t.end) : ''} · ${esc(t.city)}${rows.length ? ` · ${rows.length}` : ' · no expenses yet'}</div></div>`;
  });
  if (!items.length) html += `<p class="muted small" style="padding:8px">${trips.length ? 'No trip matches.' : 'No trips yet.'}</p>`;
  el.classList.add('tripscard');
  el.innerHTML = `<div class="panel-head"><h2>🧳 Trips</h2><div class="dbtools"><button class="btn sm" id="suggestTrips" title="Groups Travel expenses that are not in any trip yet">✨ Suggest</button><button class="btn sm primary" id="addTrip">➕ Add trip</button></div></div>
    ${trips.length > 12 ? '<input type="search" id="tripSearch" class="tripsearch" placeholder="Search trips…" autocomplete="off">' : ''}<div class="triplist" id="tripList">${html}</div>`;
  if ($('#tripSearch')) $('#tripSearch').value = T.q;
}

/** The line above the expenses table: which trip is shown, with its place, dates and the edit and delete buttons. */
function tripHeaderHtml() {
  if (!inTrips()) return '';
  const t = tripById(S.tripSel);
  if (!t) return '<div class="triphead"><div><strong>🧳 All trips</strong><div class="muted small">The expenses of every trip. Pick a trip on the left to see only that one.</div></div></div>';
  const days = daysBetween(t.start, t.end);
  return `<div class="triphead"><div><strong>🧳 ${esc(t.name)}</strong><div class="muted small">${esc(t.city)}${t.country ? ', ' + esc(t.country) : ''} · ${fmtDate(t.start)} – ${fmtDate(t.end)} · ${days} ${days === 1 ? 'day' : 'days'}</div></div>
    <div class="dbtools"><button class="btn sm" data-edittrip="${esc(t.id)}">✎ Edit trip</button><button class="btn sm danger" data-deltrip="${esc(t.id)}">🗑️ Delete trip</button></div></div>`;
}

/** Opens a trip in the Trips tab (from the 🧳 of an expense, from any tab). */
async function openTrip(id) {
  const was = D.tab === 'trips';
  S.tripSel = id; T.q = '';
  await setTab('trips');
  if (was && D.tab === 'trips') renderAll();
  if (D.tab === 'trips') window.scrollTo(0, 0);
}

document.addEventListener('click', ev => {
  const r = ev.target.closest('[data-tripsel]');
  if (r) { const id = r.dataset.tripsel; S.tripSel = id && S.tripSel === id ? '' : id; S.limit = 100; S.collapsed.clear(); renderAll(); return; }
  if (ev.target.closest('[data-gotrips]')) setTab('trips');
});
document.addEventListener('input', ev => { if (ev.target.id === 'tripSearch') { T.q = ev.target.value; renderTripsCard(); const i = $('#tripSearch'); if (i) { i.focus(); i.setSelectionRange(T.q.length, T.q.length); } } });
