'use strict';
/* Shared by the dashboard and the phone page (the server copies this file into Mobile/expenses.html): how numbers, dates and times
   are shown, how typed amounts are read, and how search matches. */

/* ---------- regional format ----------
   Every choice is 'auto' unless changed in Settings > Regional format. Automatic means the settings of the computer that runs the
   server (`system`, read on macOS and Windows); without them (Linux, the phone page) the browser's language and region.
   number: auto | dot (1,234.50) | comma (1.234,50)       symbol: auto | before | after
   date:   auto | text (15 Sep 2026) | dmy | mdy | iso     time:   auto | 24 | 12 */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const textDate = iso => { const [y, m, d] = iso.split('-'); return `${d} ${MONTH_NAMES[+m - 1]} ${y}`; };
/** A date written with a system pattern such as dd/MM/yy, M/d/yyyy or d. MMM y; quoted text is literal and weekdays are left out. */
const DATE_TOKEN = /'[^']*'|[Ee]+[,. ]*|d{3,}[,. ]*|y+|M+|L+|d+|[^'EeyMLd]+/g;
function formatPattern(pattern, iso) {
  const [y, m, d] = iso.split('-');
  return (pattern.match(DATE_TOKEN) || []).map(t => {
    if (t[0] === "'") return t.slice(1, -1);
    if (/^([Ee]|d{3})/.test(t)) return '';
    if (t[0] === 'y') return t.length === 2 ? y.slice(2) : y;
    if (t[0] === 'M' || t[0] === 'L') return t.length >= 3 ? MONTH_NAMES[+m - 1] : t.length === 2 ? m : String(+m);
    if (t[0] === 'd') return t.length === 2 ? d : String(+d);
    return t;
  }).join('').trim();
}
const patternLetters = pattern => (pattern.match(DATE_TOKEN) || []).map(t => {
  if (t[0] === "'") return t.slice(1, -1);
  if (/^([Ee]|d{3})/.test(t)) return '';
  if (t[0] === 'y') return t.length === 2 ? 'YY' : 'YYYY';
  if (t[0] === 'M' || t[0] === 'L') return t.length >= 3 ? 'Mon' : 'M'.repeat(t.length);
  if (t[0] === 'd') return 'D'.repeat(t.length);
  return t;
}).join('').trim();

function makeFormat(prefs, system, locale = (typeof navigator !== 'undefined' && navigator.language) || 'en-GB') {
  const sys = system || {};
  const p = { number: 'auto', symbol: 'auto', date: 'auto', time: 'auto', ...(prefs || {}) };
  let loc;
  try { loc = new Intl.Locale(locale, { numberingSystem: 'latn', calendar: 'gregory' }).toString(); new Intl.NumberFormat(loc); } catch { loc = 'en-GB'; }
  const numLoc = p.number === 'dot' ? 'en-GB' : p.number === 'comma' ? 'de-DE' : loc;
  const own = p.number === 'auto' && !!sys.decimal;   // separators taken from the system
  const decimal = own ? sys.decimal : new Intl.NumberFormat(numLoc).formatToParts(1.5).find(x => x.type === 'decimal').value;
  const side = p.symbol !== 'auto' ? p.symbol : p.number === 'dot' ? 'before' : p.number === 'comma' ? 'after' : sys.symbol || '';
  const gap = p.number === 'auto' && sys.symbol ? sys.spaced : null;
  const fixed = (v, digits) => Number(v).toFixed(digits).replace('.', decimal);
  const grouped = (v, digits) => {
    if (!own) return new Intl.NumberFormat(numLoc, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).formatToParts(v)
      .map(x => (x.type === 'group' ? sys.group || '' : x.type === 'decimal' ? decimal : x.value)).join('');
  };
  const cache = {};
  const money = (v, cur) => {
    try {
      if (!side) return (cache[cur] ??= new Intl.NumberFormat(loc, { style: 'currency', currency: cur })).format(v);
      const c = cache[cur] ??= (() => {
        const f = new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }), d = f.resolvedOptions().maximumFractionDigits;
        return { sym: f.formatToParts(1).find(x => x.type === 'currency').value, digits: d };
      })();
      const n = grouped(Math.abs(v), c.digits), neg = v < 0 && /[1-9]/.test(n) ? '-' : '';
      if (side === 'after') return neg + n + (gap === false ? '' : ' ') + c.sym;
      return neg + c.sym + (gap || /\p{L}$/u.test(c.sym) ? ' ' : '') + n;
    } catch { return `${fixed(v, 2)} ${cur}`; }
  };
  const auto = new Intl.DateTimeFormat(loc, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const date = iso => {
    const [y, m, d] = iso.split('-');
    if (p.date === 'text') return textDate(iso);
    if (p.date === 'dmy') return `${d}/${m}/${y}`;
    if (p.date === 'mdy') return `${m}/${d}/${y}`;
    if (p.date === 'iso') return iso;
    return sys.date ? formatPattern(sys.date, iso) : auto.format(new Date(Date.UTC(+y, +m - 1, +d)));
  };
  const autoPattern = sys.date ? patternLetters(sys.date)
    : auto.formatToParts(new Date(Date.UTC(2026, 10, 25))).map(x => ({ day: 'DD', month: 'MM', year: 'YYYY' }[x.type] || x.value)).join('');
  const monthFirst = p.date === 'mdy' || (p.date === 'auto' && /^M[^Y]*D/.test(autoPattern));
  const clock = p.time !== 'auto' ? p.time : sys.time;
  const timeFmt = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', ...(clock === '24' ? { hourCycle: 'h23' } : clock === '12' ? { hourCycle: 'h12' } : {}) });
  return { money, date, autoPattern, monthFirst, decimal, fixed, input: v => fixed(v, 2), time: d => timeFmt.format(d) };
}

/** "1,234.50", "1.234,50", "12,5" and "12.5" as plain "1234.50" text: with both separators, the last one is the decimal one. */
function plainNumber(s) {
  const t = String(s).replace(/\s/g, ''), comma = t.lastIndexOf(','), dot = t.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) return comma > dot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  return comma >= 0 ? t.replace(',', '.') : t;
}

/* ---------- search ----------
   Ignores case and accents ("aigu" finds "Aigües") and, in names, spaces and punctuation ("mcdonalds" finds "McDonald's",
   "elcorte" finds "El Corte Inglés"). An amount can be typed with a comma or a dot. Every word typed must be found; there is no
   fuzzy matching, because the results are added up into totals. */
const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const squash = s => s.replace(/[^\p{L}\p{N}]+/gu, '');
function searchWords(query) {
  return fold(query).split(/\s+/).filter(Boolean).map(w => {
    const forms = [w];
    if (/^-?\d[\d.,]*$/.test(w) && w.includes(',')) {
      forms.push(/^-?\d{1,3}(,\d{3})+(\.\d*)?$/.test(w) ? w.replace(/,/g, '') : w.replace(/\./g, '').replace(',', '.'));
      if (/^-?\d+,\d{3}$/.test(w)) forms.push(w.replace(',', '.'));
    }
    return { forms, name: /\p{L}/u.test(w) ? squash(w) : '' };
  });
}
/** names: short fields (merchant, category, place), also compared without spaces and punctuation; rest: notes, amount, date. */
function searchMatch(words, names, rest = '') {
  if (!words.length) return true;
  const text = fold(`${names.join(' ')} ${rest}`), joined = text.replace(/(?<=\p{L})['’.·\-](?=\p{L})/gu, ''), compact = names.map(n => squash(fold(n)));
  return words.every(w => w.forms.some(f => text.includes(f) || joined.includes(f)) || (!!w.name && compact.some(n => n.includes(w.name))));
}
