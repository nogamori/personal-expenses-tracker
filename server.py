#!/usr/bin/env python3
"""Local expenses server (Python standard library only).

Serves public/ and Receipts/, and exposes a small JSON API that validates every change, keeps
timestamped backups, and writes data/expenses.json atomically.

Start:  python3 server.py [--port 8765]      Stop: Ctrl+C
Listens on 127.0.0.1 only.
"""
import argparse, copy, gzip, json, mimetypes, os, platform, re, sys, threading, time, uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data", "expenses.json")
BACKUPS = os.path.join(ROOT, "data", "backups")
PUBLIC = os.path.join(ROOT, "public")
RECEIPTS = os.path.join(ROOT, "Receipts")
KEEP_BACKUPS = 30
HISTORY = os.path.join(ROOT, "data", "history.json")
KEEP_HISTORY = 10
LOCK = threading.Lock()
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_UPLOAD = 25 * 1024 * 1024
EDITABLE = ("date", "merchant", "amount", "currency", "category", "subcategory", "notes", "tripId")
RECEIPT_NAME = re.compile(r"^\d{8}_\d{6}\.(jpg|png|gif|webp|heic|pdf)$")
# Fixed types for the app's own files: on Windows Python reads the registry, which can say .js is text/plain and the browser then refuses the script
for _t, _e in (("text/html", ".html"), ("text/css", ".css"), ("text/javascript", ".js"), ("application/json", ".json"), ("image/svg+xml", ".svg")):
    mimetypes.add_type(_t, _e)
for _t, _e in (("image/heic", ".heic"), ("image/heif", ".heif"), ("image/webp", ".webp")):
    mimetypes.add_type(_t, _e)


def sniff_ext(d):
    """File type from the content itself (never from the client's file name)."""
    if d[:3] == b"\xff\xd8\xff": return "jpg"
    if d[:8] == b"\x89PNG\r\n\x1a\n": return "png"
    if d[:6] in (b"GIF87a", b"GIF89a"): return "gif"
    if d[:4] == b"RIFF" and d[8:12] == b"WEBP": return "webp"
    if b"%PDF-" in d[:1024]: return "pdf"
    if d[4:8] == b"ftyp" and d[8:12] in (b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1"): return "heic"
    return None


def new_receipt_name(ext):
    """Receipt IDs have the format YYYYMMDD_HHMMSS; if taken, the next free second is used."""
    t = datetime.now()
    while True:
        stem = t.strftime("%Y%m%d_%H%M%S")
        if not any(n.startswith(stem + ".") for n in os.listdir(RECEIPTS)):
            return stem, f"{stem}.{ext}"
        t += timedelta(seconds=1)



STARTED = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class ApiError(Exception):
    def __init__(self, status, message, details=None):
        super().__init__(message)
        self.status, self.message, self.details = status, message, details or []


# ---------- prompt generation ----------
TEMPLATE = os.path.join(ROOT, "prompts", "receipt-prompt.template.md")
PROMPT_OUT = os.path.join(ROOT, "data", "receipt-prompt.md")
MOBILE_TEMPLATE = os.path.join(ROOT, "templates", "mobile.template.html")
MOBILE_OUT = os.path.join(ROOT, "Mobile", "expenses.html")
# role -> default (category, subcategory). Rules in the prompt template refer to roles, not names.
ROLES = {
    "bar_restaurant": ("Leisure & Entertainment", "Bars & Restaurants"),
    "cafe": ("Food", "Cafés & Snacks"),
    "groceries": ("Food", "Groceries"),
    "alcohol": ("Leisure & Entertainment", "Alcoholic Drinks"),
    "toiletries": ("Personal Shopping", "Hygiene & Beauty"),
    "cleaning": ("Housing", "Cleaning Supplies"),
    "unclassified": ("Other", "Unclassified"),
    "travel": ("Travel", ""),
    "travel_bar_restaurant": ("Travel", "Bars & Restaurants"),
    "travel_cafe": ("Travel", "Cafés & Snacks"),
    "travel_groceries": ("Travel", "Travel Groceries"),
    "travel_alcohol": ("Travel", "Alcoholic Drinks"),
    "travel_vehicle": ("Travel", "Vehicle"),
    "taxi": ("Transport", "Taxi & Rideshare"),
}
DEFAULT_HINTS = {
    ("Travel", None): "Spending on a trip that fits a Travel subcategory: transport, accommodation, food and drink, activities and vehicle. Other purchases made on a trip keep their normal category.",
    ("Travel", "Transport Tickets"): "Flights, intercity trains and buses, ferries.",
    ("Travel", "Accommodation"): "Hotels, hostels, rentals, camping.",
    ("Travel", "Travel Groceries"): "Supermarkets and take-away bakery purchases only.",
    ("Travel", "Cafés & Snacks"): "Cafés, bakeries with tables, snack bars, food trucks, fast food while travelling.",
    ("Travel", "Bars & Restaurants"): "Bars, restaurants, pubs, breweries, wine bars while travelling.",
    ("Travel", "Alcoholic Drinks"): "Bottles bought to take away while travelling.",
    ("Travel", "Activities & Sightseeing"): "Museums, tours, attractions, shows, events.",
    ("Travel", "Vehicle"): "Car rental, fuel, tolls, parking, fines, and taxi or ride-hailing (Uber, Cabify, Bolt, FreeNow) rides.",
    ("Transport", "Taxi & Rideshare"): "Taxi or ride-hailing rides inside the home city only, and never to or from an airport. Every other taxi or ride-hailing ride is Travel › Vehicle.",
    ("Leisure & Entertainment", "Bars & Restaurants"): "Bars, restaurants, pubs, breweries, wine bars, taverns, bistros (consumed on the premises).",
    ("Leisure & Entertainment", "Alcoholic Drinks"): "Alcohol bought to take away (supermarkets, wine shops, liquor stores).",
    ("Food", "Cafés & Snacks"): "Cafés, bakeries with tables, snack bars, food trucks, fast food.",
    ("Food", "Groceries"): "Supermarket items and take-away bakery purchases.",
    ("Housing", "Cleaning Supplies"): "Cleaning products, including those bought in a supermarket.",
    ("Personal Shopping", "Hygiene & Beauty"): "Toiletries, including those bought in a supermarket.",
    ("Personal Shopping", "Gifts"): "Gifts bought for other people.",
    ("Health", "Fitness"): "Gym memberships and fitness classes.",
    ("Work", None): "Work-related spending: coworking, office supplies and printing.",
    ("Work", "Coworking"): "Coworking space rent and day passes.",
    ("Work", "Office Supplies"): "Pens, paper, notebooks, printing, photocopies and other stationery for work.",
    ("Education", None): "Courses, classes and learning.",
    ("Education", "Courses"): "Language and other courses, classes and tuition.",
    ("Other", "Unclassified"): "Use only when nothing else fits.",
}


DEFAULT_EMOJI = {"Housing": "🏠", "Food": "🍽️", "Transport": "🚇", "Health": "🩺", "Subscriptions & Digital Services": "📱",
                 "Personal Shopping": "🛍️", "Leisure & Entertainment": "🎭", "Travel": "✈️", "Pets": "🐱", "Other": "📦", "Work": "💼", "Education": "🎓"}


DEFAULT_SUB_EMOJI = {
    ("Housing", "Rent"): "🔑", ("Housing", "Electricity"): "💡", ("Housing", "Water & Sewage"): "🚰", ("Housing", "Gas"): "🔥",
    ("Housing", "Internet"): "🌐", ("Housing", "Maintenance & Repairs"): "🔧", ("Housing", "Phone"): "📞", ("Housing", "Furniture"): "🛋️",
    ("Housing", "Decor"): "🖼️", ("Housing", "Household Items"): "🍳", ("Housing", "Cleaning Supplies"): "🧽",
    ("Food", "Groceries"): "🛒", ("Food", "Cafés & Snacks"): "☕", ("Food", "Delivery"): "🛵",
    ("Transport", "Public Transit"): "🚌", ("Transport", "Taxi & Rideshare"): "🚕",
    ("Health", "Health Insurance"): "🛡️", ("Health", "Doctor Visits"): "🏥", ("Health", "Tests & Exams"): "🔬", ("Health", "Medication"): "💊",
    ("Health", "Dentist"): "🦷", ("Health", "Therapy"): "🧠", ("Health", "General"): "🩹", ("Health", "Fitness"): "🏋️",
    ("Work", "Coworking"): "🏢", ("Work", "Office Supplies"): "✏️", ("Education", "Courses"): "🏫",
    ("Subscriptions & Digital Services", "Streaming"): "📺", ("Subscriptions & Digital Services", "Cloud Storage"): "☁️",
    ("Subscriptions & Digital Services", "Software & Apps"): "🖥️",
    ("Personal Shopping", "Clothing"): "👕", ("Personal Shopping", "Shoes"): "👟", ("Personal Shopping", "Electronics"): "💻",
    ("Personal Shopping", "Personal Items"): "🎒", ("Personal Shopping", "Hygiene & Beauty"): "🧴", ("Personal Shopping", "Gifts"): "🎁",
    ("Leisure & Entertainment", "Cinema & Events"): "🎟️", ("Leisure & Entertainment", "Bars & Restaurants"): "🍻",
    ("Leisure & Entertainment", "Hobbies"): "🎨", ("Leisure & Entertainment", "Books"): "📚", ("Leisure & Entertainment", "Alcoholic Drinks"): "🍷",
    ("Travel", "Transport Tickets"): "🎫", ("Travel", "Accommodation"): "🏨", ("Travel", "Travel Groceries"): "🛒", ("Travel", "Cafés & Snacks"): "☕",
    ("Travel", "Bars & Restaurants"): "🍻", ("Travel", "Alcoholic Drinks"): "🍷", ("Travel", "Activities & Sightseeing"): "🏛️", ("Travel", "Vehicle"): "🚗",
    ("Pets", "Food"): "🐟", ("Pets", "Litter"): "🧺", ("Pets", "Toys"): "🧶", ("Pets", "Vet"): "💉", ("Pets", "Other"): "🐾",
    ("Other", "Unclassified"): "❓",
}


DEFAULT_HOME_CITY = "London"


def ensure_defaults(doc):
    """Add promptRoles, settings, trips and default hints/emojis if missing. Returns True if the document changed."""
    changed = False
    if not (doc.get("settings") or {}).get("homeCity"):
        doc.setdefault("settings", {})["homeCity"] = DEFAULT_HOME_CITY; changed = True
    if "trips" not in doc:
        doc["trips"] = []; changed = True
    cats = {c["name"]: c for c in doc.get("categories", [])}
    roles = doc.setdefault("promptRoles", {})
    for k, (cat, sub) in ROLES.items():
        if k not in roles and cat in cats and (sub == "" or sub in cats[cat]["subcategories"]):
            roles[k] = {"category": cat, "subcategory": sub}; changed = True
    if "promptRoles" not in doc: changed = True
    for (cat, sub), em in DEFAULT_SUB_EMOJI.items():
        c = cats.get(cat)
        if c and sub in c["subcategories"] and sub not in c.setdefault("subcategoryEmoji", {}):
            c["subcategoryEmoji"][sub] = em; changed = True
    for c in doc.get("categories", []):
        if "emoji" not in c and c["name"] in DEFAULT_EMOJI:
            c["emoji"] = DEFAULT_EMOJI[c["name"]]; changed = True
    for (cat, sub), hint in DEFAULT_HINTS.items():
        c = cats.get(cat)
        if not c: continue
        if sub is None:
            if "hint" not in c: c["hint"] = hint; changed = True
        elif sub in c["subcategories"] and sub not in c.setdefault("subcategoryHints", {}):
            c["subcategoryHints"][sub] = hint; changed = True
    return changed


def render_prompt(doc):
    with open(TEMPLATE, encoding="utf-8") as f:
        text = f.read()
    roles = doc["promptRoles"]

    def role(m):
        r = roles[m.group(1)]
        return f"{r['category']} / {r['subcategory']}" if r["subcategory"] else r["category"]
    text = re.sub(r"\{\{role:([a-z_]+)\}\}", role, text)
    text = text.replace("{{HOME_CITY}}", doc.get("settings", {}).get("homeCity") or DEFAULT_HOME_CITY)
    trips = sorted(doc.get("trips", []), key=lambda t: t["start"])
    text = text.replace("{{TRIPS}}", "\n".join(
        f'- "{t["name"]}" — {t["city"]}{", " + t["country"] if t.get("country") else ""} — {t["start"]} to {t["end"]}' for t in trips) or "(none registered)")
    lines = []
    for c in doc["categories"]:
        lines.append(f"- {c['name']}" + (f" — {c['hint']}" if c.get("hint") else ""))
        for s in c["subcategories"]:
            h = c.get("subcategoryHints", {}).get(s)
            lines.append(f"  - {s}" + (f" — {h}" if h else ""))
    return text.replace("{{CATEGORIES}}", "\n".join(lines))


def write_prompt(doc):
    """Render data/receipt-prompt.md atomically. Returns a warning string or None."""
    try:
        out = render_prompt(doc)
        tmp = PROMPT_OUT + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(out); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, PROMPT_OUT)
        return None
    except Exception as ex:
        return f"The data was saved, but the prompt file could not be regenerated: {ex}"


def write_mobile(doc):
    """Render Mobile/expenses.html, a read-only copy of the data in one self-contained page, atomically. Returns a warning or None."""
    try:
        with open(MOBILE_TEMPLATE, encoding="utf-8") as f: tpl = f.read()
        payload = {
            "generated": now_iso(),
            "categories": [{"n": c["name"], "e": c.get("emoji", ""),
                            "subs": [[s, (c.get("subcategoryEmoji") or {}).get(s, "")] for s in c["subcategories"]]} for c in doc["categories"]],
            "trips": {t["id"]: t["name"] for t in doc.get("trips", [])},
            "tripInfo": {t["id"]: [t["start"], t["end"], t["city"], t.get("country", "")] for t in doc.get("trips", [])},
            "rows": [[e["date"], e["merchant"], e["amount"], e["currency"], e["category"], e["subcategory"], e.get("notes", ""), e.get("tripId", ""),
                      (f"{e['installment']['index']}/{e['installment']['count']}" if e.get("installment") else ""),
                      (e.get("receiptFile") or "").split("/", 1)[-1], e["id"], e.get("updatedAt") or "", (e.get("installment") or {}).get("groupId", "")] for e in doc["expenses"]],
        }
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        out = tpl.replace("/*DATA*/null", data, 1)
        os.makedirs(os.path.dirname(MOBILE_OUT), exist_ok=True)
        tmp = MOBILE_OUT + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(out); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, MOBILE_OUT)
        return None
    except Exception as ex:
        return f"The data was saved, but the mobile page could not be regenerated: {ex}"


# ---------- validation ----------
def valid_date(s):
    if not isinstance(s, str) or not ISO_DATE.match(s):
        return False
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def valid_name(s):
    return isinstance(s, str) and s.strip() == s and len(s) > 0 and s[0].isupper()


def expense_errors(e, categories, trip_ids=None):
    errs = []
    if not valid_date(e.get("date")):
        errs.append({"field": "date", "message": "Date must be a valid date (YYYY-MM-DD)."})
    if not isinstance(e.get("merchant"), str) or not e["merchant"].strip():
        errs.append({"field": "merchant", "message": "Merchant is required."})
    a = e.get("amount")
    if isinstance(a, bool) or not isinstance(a, (int, float)) or a != a or abs(a) > 1e9:
        errs.append({"field": "amount", "message": "Amount must be a number."})
    elif a == 0:
        errs.append({"field": "amount", "message": "Amount cannot be zero (use a negative amount for a refund)."})
    elif round(a, 2) != a:
        errs.append({"field": "amount", "message": "Amount can have at most 2 decimal places."})
    if not isinstance(e.get("currency"), str) or not re.fullmatch(r"[A-Z]{3}", e["currency"]):
        errs.append({"field": "currency", "message": "Currency must be a 3-letter code such as EUR."})
    cat, sub = e.get("category"), e.get("subcategory", "")
    subs = {c["name"]: c["subcategories"] for c in categories}
    if cat not in subs:
        errs.append({"field": "category", "message": "Choose an existing category."})
    elif sub not in ("", None) and sub not in subs[cat]:
        errs.append({"field": "subcategory", "message": f"'{sub}' is not a subcategory of {cat}."})
    if not isinstance(e.get("notes", ""), str):
        errs.append({"field": "notes", "message": "Notes must be text."})
    ed = e.get("enteredDate")
    if ed is not None and not valid_date(ed):
        errs.append({"field": "enteredDate", "message": "Entered date must be YYYY-MM-DD."})
    tid = e.get("tripId")
    if tid not in (None, "") and (not isinstance(tid, str) or (trip_ids is not None and tid not in trip_ids)):
        errs.append({"field": "tripId", "message": "Choose an existing trip."})
    ins = e.get("installment")
    if ins is not None and not (isinstance(ins, dict) and isinstance(ins.get("groupId"), str) and isinstance(ins.get("index"), int)
                                and isinstance(ins.get("count"), int) and 1 <= ins["index"] <= ins["count"]
                                and (ins.get("purchaseDate") is None or valid_date(ins["purchaseDate"]))):
        errs.append({"field": "installment", "message": "Installment details are invalid."})
    rf = e.get("receiptFile")
    if rf is not None and (not isinstance(rf, str) or not re.fullmatch(r"Receipts/[^/\\]+", rf) or ".." in rf):
        errs.append({"field": "receiptFile", "message": "Receipt file must look like Receipts/<file name>."})
    return errs


def document_errors(doc):
    errs = []
    if doc.get("schemaVersion") != 1:
        errs.append({"field": "schemaVersion", "message": "Unsupported schemaVersion."})
    seen_c = set()
    for c in doc.get("categories", []):
        if not valid_name(c.get("name")):
            errs.append({"field": "categories", "message": f"Invalid category name {c.get('name')!r}."})
        if c.get("name") in seen_c:
            errs.append({"field": "categories", "message": f"Duplicate category {c.get('name')!r}."})
        seen_c.add(c.get("name"))
        seen_s = set()
        for s in c.get("subcategories", []):
            if not valid_name(s) or s in seen_s:
                errs.append({"field": "categories", "message": f"Invalid or duplicate subcategory {s!r} in {c.get('name')}."})
            seen_s.add(s)
    subs_by = {c.get("name"): c.get("subcategories", []) for c in doc.get("categories", [])}
    for c in doc.get("categories", []):
        if not isinstance(c.get("hint", ""), str) or len(c.get("hint", "")) > 400:
            errs.append({"field": "categories", "message": f"Invalid hint for {c.get('name')}."})
        em = c.get("emoji", "")
        if not isinstance(em, str) or len(em) > 10 or re.search(r"[A-Za-z0-9]", em):
            errs.append({"field": "categories", "message": f"Invalid emoji for {c.get('name')}."})
        for k, em2 in c.get("subcategoryEmoji", {}).items():
            if k not in c.get("subcategories", []) or not isinstance(em2, str) or len(em2) > 10 or re.search(r"[A-Za-z0-9]", em2):
                errs.append({"field": "categories", "message": f"Invalid emoji for {c.get('name')} / {k}."})
        for k, h in c.get("subcategoryHints", {}).items():
            if k not in c.get("subcategories", []) or not isinstance(h, str) or len(h) > 400:
                errs.append({"field": "categories", "message": f"Invalid hint for {c.get('name')} / {k}."})
    roles = doc.get("promptRoles", {})
    for k in ROLES:
        r = roles.get(k)
        if not r or r.get("category") not in subs_by or (r.get("subcategory") not in subs_by[r["category"]] and not (k == "travel" and r.get("subcategory") == "")):
            errs.append({"field": "promptRoles", "message": f"Prompt rule '{k}' must point to an existing category/subcategory."})
    st = doc.get("settings")
    if not isinstance(st, dict) or not isinstance(st.get("homeCity"), str) or not st["homeCity"].strip() or len(st["homeCity"]) > 80:
        errs.append({"field": "settings", "message": "The home city is required (up to 80 characters)."})
    trip_ids, seen_t = set(), set()
    for t in doc.get("trips", []):
        if not isinstance(t, dict) or not isinstance(t.get("id"), str) or t["id"] in seen_t:
            errs.append({"field": "trips", "message": "Every trip needs a unique id."}); continue
        seen_t.add(t["id"]); trip_ids.add(t["id"])
        if not isinstance(t.get("name"), str) or not t["name"].strip() or len(t["name"]) > 80:
            errs.append({"field": "trips", "message": f"Trip {t['id']}: the name is required (up to 80 characters)."})
        if not isinstance(t.get("city"), str) or not t["city"].strip() or len(t["city"]) > 80 or len(t.get("country") or "") > 80:
            errs.append({"field": "trips", "message": f"Trip {t.get('name')}: the city is required (up to 80 characters)."})
        if not valid_date(t.get("start")) or not valid_date(t.get("end")) or t["start"] > t["end"]:
            errs.append({"field": "trips", "message": f"Trip {t.get('name')}: use valid dates, with the start on or before the end."})
    ids = set()
    for e in doc.get("expenses", []):
        if e.get("id") in ids:
            errs.append({"field": "id", "message": f"Duplicate id {e.get('id')}."})
        ids.add(e.get("id"))
        for x in expense_errors(e, doc.get("categories", []), trip_ids):
            errs.append({**x, "message": f"{e.get('id')}: {x['message']}"})
    return errs


# ---------- checks and information (used by the Settings page and scripts/validate.py) ----------
CARD_RE = re.compile(r"(?i)(cart[ãa]o|cartao|card|tarjeta|visa|mastercard)\b[^0-9\n]{0,30}?\d[\d ]{11,22}\d")


def run_checks(doc):
    """Integrity checks. Returns {"checks": [{name, ok, detail}], "info": {...}}."""
    ex, checks = doc["expenses"], []
    add = lambda name, ok, detail="": checks.append({"name": name, "ok": bool(ok), "detail": detail})
    errs = document_errors(doc)
    add("Data format and field rules", not errs, "; ".join(e["message"] for e in errs[:3]))
    add("Unique expense ids", len({e["id"] for e in ex}) == len(ex))
    missing = [e["receiptFile"] for e in ex if e.get("receiptFile") and not os.path.isfile(os.path.join(ROOT, e["receiptFile"]))]
    add("Every linked receipt file exists", not missing, f"{len(missing)} missing, for example {missing[:2]}" if missing else "")
    add("No full card numbers in notes", not any(CARD_RE.search(e.get("notes", "")) for e in ex))
    add("Category names start with an uppercase letter", all(c["name"][:1].isupper() and all(x[:1].isupper() for x in c["subcategories"]) for c in doc["categories"]))
    try:
        on_disk = {n for n in os.listdir(RECEIPTS) if not n.startswith(".")}
    except OSError:
        on_disk = set()
    linked = {os.path.basename(e["receiptFile"]) for e in ex if e.get("receiptFile")}
    return {"checks": checks, "info": {"filesNotLinked": len(on_disk - linked), "receiptFiles": len(on_disk), "receiptsLinked": len(linked)}}


def about_info(doc):
    def count(path):
        try: return len([n for n in os.listdir(path) if not n.startswith(".")])
        except OSError: return 0
    try:
        with open(os.path.join(ROOT, "VERSION"), encoding="utf-8") as f: version = f.read().strip()
    except OSError:
        version = ""
    info = run_checks(doc)["info"]
    return {"version": version, "schemaVersion": doc.get("schemaVersion"), "revision": doc.get("revision"), "updatedAt": doc.get("updatedAt"),
            "counts": {"expenses": len(doc["expenses"]), "categories": len(doc["categories"]),
                       "subcategories": sum(len(c["subcategories"]) for c in doc["categories"]), **info},
            "backups": count(BACKUPS), "historyActions": len(read_history()),
            "paths": {"app": ROOT, "data": DATA, "receipts": RECEIPTS, "backups": BACKUPS, "prompt": PROMPT_OUT},
            "python": platform.python_version(), "startedAt": STARTED}


# ---------- Inbox: receipts and requests left by a phone automation ----------
INBOX = os.path.join(ROOT, "Inbox")
INBOX_PROCESSED = os.path.join(INBOX, "Processed")
INBOX_FAILED = os.path.join(INBOX, "Failed")
INBOX_STATE = {"last": None}
INBOX_SUFFIXES = (".json", ".txt")   # some automation tools can only save .txt
INBOX_POLL_SECONDS = 20
INBOX_MAX_BYTES = 1_000_000   # a request or a model reply is a few KB; anything bigger is refused unread
DEFER_SECONDS = 600     # wait this long for the receipt file to arrive (a sync service) before importing without it
RECEIPT_ID_RE = re.compile(r"^\d{8}_\d{6}$")
CURRENCY_SYMBOLS = {"€": "EUR", "R$": "BRL", "US$": "USD", "$": "USD", "£": "GBP", "¥": "JPY"}
CARD_MASK_RE = re.compile(r"(?i)((?:cart[ãa]o|cartao|card|tarjeta|visa|mastercard|master)\b[^0-9\n]{0,30}?)(\d[\d ]{11,22}\d)(?!\d)")


class Defer(Exception):
    """The receipt file has not arrived yet; try again later."""


def mask_cards(text):
    def sub(m):
        digits = re.sub(r"\D", "", m.group(2))
        return m.group(1) + "•••• " + digits[-4:] if 13 <= len(digits) <= 19 else m.group(0)
    return CARD_MASK_RE.sub(sub, text)


def parse_model_json(text):
    """The model should answer with bare JSON; tolerate code fences or a sentence around it."""
    i, j = text.find("{"), text.rfind("}")
    if i < 0 or j <= i: raise ValueError("No JSON object found in the file.")
    try:
        return json.loads(text[i:j + 1])
    except json.JSONDecodeError as ex:
        raise ValueError(f"The JSON is not valid ({ex}).")


def norm_date(v):
    s = str(v or "").strip()
    if valid_date(s): return s
    m = re.fullmatch(r"(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})", s)
    if m:
        y = int(m.group(3)); y += 2000 if y < 100 else 0
        iso = f"{y:04d}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
        if valid_date(iso): return iso
    raise ValueError(f"Invalid date “{s}”.")


def norm_amount(v):
    s = str(v).strip().replace(" ", "")
    if "," in s and "." in s: s = s.replace(",", "")
    elif "," in s: s = s.replace(",", ".")
    if not re.fullmatch(r"-?\d+(\.\d+)?", s): raise ValueError(f"Invalid amount “{v}”.")
    a = round(float(s), 2)
    if a == 0: raise ValueError("The amount cannot be zero.")
    return a


def norm_currency(v):
    s = str(v or "EUR").strip()
    s = CURRENCY_SYMBOLS.get(s, s).upper()
    if not re.fullmatch(r"[A-Z]{3}", s): raise ValueError(f"Invalid currency “{v}”.")
    return s


def receipt_file_for(rid):
    try:
        for n in sorted(os.listdir(RECEIPTS)):
            if n.startswith(rid + ".") and not n.startswith("."): return f"Receipts/{n}"
    except OSError:
        pass
    return None


def build_entries(doc, data, filename, allow_missing_receipt):
    """Turns one inbox file into expense records. Raises ValueError (file rejected) or Defer."""
    entries = data.get("entries")
    if not isinstance(entries, list) or not entries: raise ValueError("The file has no entries.")
    rid = str(data.get("receiptId") or "").strip()
    if not RECEIPT_ID_RE.match(rid):
        stem = os.path.splitext(filename)[0]
        if not RECEIPT_ID_RE.match(stem): raise ValueError("The receipt id is missing or not in the format YYYYMMDD_HHMMSS.")
        rid = stem
    rfile = receipt_file_for(rid)
    if rfile is None and not allow_missing_receipt: raise Defer()
    scan = f"{rid[:4]}-{rid[4:6]}-{rid[6:8]}"
    cats = {c["name"].lower(): c for c in doc["categories"]}
    trips = {t["name"].lower(): t for t in doc.get("trips", [])}
    trip_ids = {t["id"] for t in doc.get("trips", [])}
    out = []
    for k, x in enumerate(entries, 1):
        try:
            if not isinstance(x, dict): raise ValueError("The entry is not an object.")
            merchant = str(x.get("merchant") or "").strip()
            if not merchant: raise ValueError("The merchant is missing.")
            notes = mask_cards(str(x.get("notes") or "").strip())
            cat = cats.get(str(x.get("category") or "").strip().lower())
            sub = ""
            if cat:
                sub = next((s for s in cat["subcategories"] if s.lower() == str(x.get("subcategory") or "").strip().lower()), "")
            else:
                guess = str(x.get("category") or "").strip().lower()
                owners = [c for c in doc["categories"] if any(s.lower() == guess for s in c["subcategories"])]
                if len(owners) == 1:       # the model put a subcategory name in the category field
                    cat = owners[0]; sub = next(s for s in cat["subcategories"] if s.lower() == guess)
                else:
                    notes = (notes + f" [The model suggested the category “{x.get('category')}”, which does not exist.]").strip()
                    cat = cats["other"] if "other" in cats else next(iter(cats.values()))
                    sub = "Unclassified" if "Unclassified" in cat["subcategories"] else ""
            trip = trips.get(str(x.get("trip") or "").strip().lower())
            e = {"id": str(uuid.uuid4()), "date": norm_date(x.get("date") or scan), "merchant": merchant, "amount": norm_amount(x.get("amount")),
                 "currency": norm_currency(x.get("currency")), "category": cat["name"], "subcategory": sub, "notes": notes,
                 "enteredDate": scan, "receiptId": rid, "receiptFile": rfile, "createdAt": now_iso(), "updatedAt": now_iso(),
                 "source": {"origin": "shortcut", "inboxFile": filename}}
            if trip: e["tripId"] = trip["id"]
            bad = expense_errors(e, doc["categories"], trip_ids)
            if bad: raise ValueError(bad[0]["message"])
            out.append(e)
        except ValueError as ex:
            raise ValueError(f"Entry {k}: {ex}")
    return out


# ---------- edit, delete and split requests from the phone ----------
APPLIED_EDITS = os.path.join(ROOT, "data", "applied-edits.json")   # ids of the requests already applied, so a file processed twice changes nothing


def read_applied():
    try:
        with open(APPLIED_EDITS, encoding="utf-8") as f: v = json.load(f)
        return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def remember_applied(ids):
    if not ids: return
    keep = (read_applied() + list(ids))[-1000:]
    tmp = APPLIED_EDITS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f: json.dump(keep, f)
    os.replace(tmp, APPLIED_EDITS)


def apply_request(doc, req):
    """Applies one request that came from the phone to `doc`: {"kind": "expense-edit", "editId", "action": edit|delete|split, "expenseId", "base", ...}.
    `base` is the expense's updatedAt when the page was built; if the expense changed since, nothing is touched.
    Returns the undo label; raises ApiError before changing anything."""
    action = req.get("action")
    if action not in ("edit", "delete", "split", "delete-plan"): raise ApiError(422, "The request has no valid action (edit, delete, split or delete-plan).")
    if action == "delete-plan":
        if not isinstance(req.get("groupId"), str) or not isinstance(req.get("members"), list): raise ApiError(422, "The request has no groupId or members.")
        return apply_delete_plan(doc, req["groupId"], req["members"])
    cur = next((x for x in doc["expenses"] if x["id"] == req.get("expenseId")), None)
    if not cur: raise ApiError(404, "That expense no longer exists (it was deleted or merged on the computer).")
    if req.get("base") != cur.get("updatedAt"):
        raise ApiError(409, f"That expense was changed after the page was built (page: {req.get('base')}, now: {cur.get('updatedAt')}). Open the page again and repeat the change.")
    if action == "delete":
        if cur.get("installment"): raise ApiError(409, "This expense is one installment of a purchase. Merge the installments on the computer before deleting it.")
        doc["expenses"].remove(cur)
        return f"Deleted expense: {cur['merchant']} ({cur['date']})"
    if action == "split":
        items = req.get("installments")
        if not isinstance(items, list): raise ApiError(422, "The request has no installments.")
        try:
            items = [{"date": norm_date(it.get("date")), "amount": norm_amount(it.get("amount"))} for it in items]
        except (ValueError, AttributeError) as ex:
            raise ApiError(422, str(ex))
        return apply_split(doc, cur["id"], items)[1]
    ch = req.get("changes")
    if not isinstance(ch, dict) or not ch: raise ApiError(422, "The request has no changes.")
    bad = [k for k in ch if k not in EDITABLE]
    if bad: raise ApiError(422, "These fields cannot be changed from the phone: " + ", ".join(bad) + ".")
    src = {}
    for k, v in ch.items():
        try:
            src[k] = norm_date(v) if k == "date" else norm_amount(v) if k == "amount" else norm_currency(v) if k == "currency" else v
        except ValueError as ex:
            raise ApiError(422, str(ex))
    e = clean_expense(src, cur)
    errs = expense_errors(e, doc["categories"], {t["id"] for t in doc.get("trips", [])})
    if errs: raise ApiError(422, errs[0]["message"], errs)
    e["updatedAt"] = now_iso()
    doc["expenses"][doc["expenses"].index(cur)] = e
    return f"Edited expense: {e['merchant']}"


def _move(src, folder):
    dst = os.path.join(folder, os.path.basename(src))
    if os.path.exists(dst): dst = os.path.join(folder, f"{int(time.time())}-{os.path.basename(src)}")
    os.replace(src, dst)
    return dst


def process_inbox():
    """Imports the JSON files the phone automation left in Inbox/. Valid files go to Inbox/Processed, rejected ones to Inbox/Failed (with an .error.txt)."""
    for d in (INBOX, INBOX_PROCESSED, INBOX_FAILED): os.makedirs(d, exist_ok=True)
    names = sorted(n for n in os.listdir(INBOX) if n.lower().endswith(INBOX_SUFFIXES) and not n.startswith(".") and os.path.isfile(os.path.join(INBOX, n)))
    summary = {"imported": 0, "edits": 0, "files": 0, "skipped": 0, "deferred": 0, "failed": [], "at": now_iso()}
    if not names: return summary
    with LOCK:
        doc = load()
        have = {(e.get("receiptId"), e["date"], e["merchant"].lower(), e["amount"], e["currency"]) for e in doc["expenses"] if e.get("receiptId")}
        new, done, changes, applied_now = [], [], [], []
        applied = set(read_applied())
        names.sort(key=lambda n: os.path.getmtime(os.path.join(INBOX, n)))      # requests are applied in the order they were made
        for n in names:
            path = os.path.join(INBOX, n)
            age = time.time() - os.path.getmtime(path)
            if age < 3: summary["deferred"] += 1; continue
            try:
                if os.path.getsize(path) > INBOX_MAX_BYTES: raise ValueError("The file is larger than 1 MB, so it was not read.")
                with open(path, encoding="utf-8") as f: text = f.read()
                data = parse_model_json(text)
                if data.get("kind") == "expense-edit":
                    edit_id = str(data.get("editId") or "")
                    if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", edit_id): raise ValueError("The request has no valid editId.")
                    if edit_id in applied: summary["skipped"] += 1; done.append(path); continue    # already applied: nothing to do
                    changes.append(apply_request(doc, data)); applied.add(edit_id); applied_now.append(edit_id)
                    done.append(path); summary["edits"] += 1; summary["files"] += 1
                    continue
                entries = build_entries(doc, data, n, allow_missing_receipt=age > DEFER_SECONDS)
            except Defer:
                summary["deferred"] += 1; continue
            except (ValueError, OSError, ApiError) as ex:
                msg = ex.message if isinstance(ex, ApiError) else str(ex)
                try:
                    with open(os.path.join(INBOX_FAILED, n + ".error.txt"), "w", encoding="utf-8") as f: f.write(msg + "\n")
                    _move(path, INBOX_FAILED)
                except OSError:
                    pass
                summary["failed"].append({"file": n, "error": msg}); continue
            fresh = []
            for e in entries:
                key = (e["receiptId"], e["date"], e["merchant"].lower(), e["amount"], e["currency"])
                if key in have: summary["skipped"] += 1; continue
                have.add(key); fresh.append(e)
            new += fresh; done.append(path); summary["files"] += 1
        if new or changes:
            doc["expenses"].extend(new)
            parts = []
            if new: parts.append(f"Imported {len(new)} {'expense' if len(new) == 1 else 'expenses'} from the inbox")
            if changes: parts.append(f"{changes[0]} (from the inbox)" if len(changes) == 1 else f"Applied {len(changes)} changes from the inbox")
            warn = save(doc, "; ".join(parts))
            remember_applied(applied_now)
            if warn: summary["promptWarning"] = warn
        for p in done:
            try: _move(p, INBOX_PROCESSED)
            except OSError: pass
        summary["imported"] = len(new)
    INBOX_STATE["last"] = summary
    return summary


def inbox_status():
    def listing(d, suffix=None):
        try: return sorted(n for n in os.listdir(d) if not n.startswith(".") and (suffix is None or n.lower().endswith(suffix)) and not n.lower().endswith(".error.txt"))
        except OSError: return []
    failed = []
    for n in listing(INBOX_FAILED, INBOX_SUFFIXES):
        try:
            with open(os.path.join(INBOX_FAILED, n + ".error.txt"), encoding="utf-8") as f: err = f.read().strip()
        except OSError:
            err = ""
        failed.append({"file": n, "error": err})
    with LOCK:
        revision = load().get("revision")
    return {"revision": revision, "pending": len(listing(INBOX, INBOX_SUFFIXES)), "failed": failed, "last": INBOX_STATE["last"]}


def inbox_loop():
    while True:
        try:
            process_inbox()
        except Exception as ex:   # never let the importer thread die
            print("Inbox import problem:", ex)
        time.sleep(INBOX_POLL_SECONDS)


# ---------- storage ----------
def read_history():
    """Last saved changes, newest first: [{id, at, label, backup}]. Each entry points to the backup taken just before it."""
    try:
        with open(HISTORY, encoding="utf-8") as f:
            h = json.load(f)
        return [x for x in h if isinstance(x, dict) and x.get("id") and x.get("backup")] if isinstance(h, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def write_history(items):
    tmp = HISTORY + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items[:KEEP_HISTORY], f, ensure_ascii=False, indent=1)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, HISTORY)


def describe_op(b):
    n, c, sub, role = b.get("name"), b.get("category"), b.get("subcategory"), b.get("role")
    return {
        "addCategory": f"Added category {n}", "renameCategory": f"Renamed category {c} → {n}", "deleteCategory": f"Deleted category {c}",
        "addSubcategory": f"Added subcategory {n} to {c}", "renameSubcategory": f"Renamed subcategory {sub} → {n}",
        "deleteSubcategory": f"Deleted subcategory {sub}", "setHint": f"Changed description of {sub or c}",
        "setEmoji": f"Changed emoji of {c}", "setSubEmoji": f"Changed emoji of {sub}", "setRole": f"Changed prompt rule “{role}”",
    }.get(b.get("op"), "Changed categories")

def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load():
    try:
        with open(DATA, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise ApiError(500, "data/expenses.json was not found. Restore it from data/backups/.")
    except json.JSONDecodeError as ex:
        raise ApiError(500, f"data/expenses.json is not valid JSON ({ex}). Restore a file from data/backups/.")


def read_backup(path):
    """Loads a backup file, compressed (.json.gz) or plain (.json)."""
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f: return json.load(f)


def migrate_backups():
    """Compresses older plain .json backups to .json.gz (about 90% smaller) and updates the undo history to the new names."""
    try: names = [n for n in os.listdir(BACKUPS) if n.endswith(".json") and not n.startswith(".")]
    except OSError: return 0
    renamed = {}
    for n in names:
        src, dst = os.path.join(BACKUPS, n), os.path.join(BACKUPS, n + ".gz")
        try:
            with open(src, "rb") as f: raw = f.read()
            tmp = dst + ".tmp"
            with open(tmp, "wb") as f: f.write(gzip.compress(raw, 9, mtime=0))
            with gzip.open(tmp, "rb") as f: ok = f.read() == raw      # verify before deleting the original
            if not ok: os.remove(tmp); continue
            os.replace(tmp, dst); os.remove(src); renamed[n] = n + ".gz"
        except OSError:
            continue
    if renamed:
        write_history([dict(h, backup=renamed.get(h["backup"], h["backup"])) for h in read_history()])
    return len(renamed)


def apply_delete_plan(doc, group_id, members=None):
    """Deletes every installment of one plan. `members` ([{"id","base"}]) is what the phone page knew: if the plan on the computer differs
    (an installment was added, removed or edited), nothing is deleted. Returns the undo label; raises ApiError before changing anything."""
    plan = [e for e in doc["expenses"] if (e.get("installment") or {}).get("groupId") == group_id]
    if not plan: raise ApiError(404, "That installment plan no longer exists (it was merged or deleted on the computer).")
    if members is not None:
        known = {m.get("id"): m.get("base") for m in members if isinstance(m, dict)}
        now = {e["id"]: e.get("updatedAt") for e in plan}
        if known != now:
            raise ApiError(409, "The installment plan was changed after the page was built (it has %d installments there, %d now, or one was edited). Open the page again and repeat the change." % (len(known), len(now)))
    ids = {e["id"] for e in plan}
    doc["expenses"] = [e for e in doc["expenses"] if e["id"] not in ids]
    first = min(plan, key=lambda e: (e["date"], e["installment"].get("index", 0)))
    return f"Deleted {len(plan)} installments of {first['merchant']}"


def apply_replace_plan(doc, group_id, items):
    """Rewrites an installment plan: the number of installments, their dates and their amounts. The first installments keep their records (receipt, notes,
    ids); extra ones are copied from the first, and surplus ones are removed. Returns the undo label; raises ApiError before changing anything."""
    members = sorted([e for e in doc["expenses"] if (e.get("installment") or {}).get("groupId") == group_id], key=lambda e: (e["installment"].get("index", 0), e["date"]))
    if not members: raise ApiError(404, "That installment plan no longer exists (it was merged or deleted).")
    if not isinstance(items, list) or not 2 <= len(items) <= 120: raise ApiError(422, "Choose between 2 and 120 installments.")
    sign = 1 if members[0]["amount"] > 0 else -1
    purchase = members[0]["installment"].get("purchaseDate")
    made = []
    for k, it in enumerate(items):
        amt = it.get("amount") if isinstance(it, dict) else None
        if not isinstance(it, dict) or not valid_date(it.get("date")) or isinstance(amt, bool) or not isinstance(amt, (int, float)) or amt * sign <= 0 or round(amt, 2) != amt:
            raise ApiError(422, f"Installment {k + 1} needs a valid date and a non-zero amount with the same sign as the purchase.")
        if k < len(members): e = copy.deepcopy(members[k])
        else:
            e = copy.deepcopy(members[0]); e["id"] = str(uuid.uuid4()); e["createdAt"] = now_iso(); e.pop("source", None)
        e.update(date=it["date"], amount=round(amt, 2), updatedAt=now_iso(), installment={"groupId": group_id, "index": k + 1, "count": len(items), "purchaseDate": purchase})
        made.append(e)
    ids = {m["id"] for m in members}
    at = min(i for i, x in enumerate(doc["expenses"]) if x["id"] in ids)
    rest = [x for x in doc["expenses"] if x["id"] not in ids]
    doc["expenses"] = rest[:at] + made + rest[at:]
    return f"Edited the installment plan of {members[0]['merchant']} ({len(members)} to {len(made)} installments)" if len(members) != len(made) else f"Edited the installment plan of {members[0]['merchant']}"


def apply_split(doc, expense_id, items):
    """Splits one purchase into installments (one entry each). Returns (new entries, undo label); raises ApiError before changing anything."""
    pos = next((i for i, x in enumerate(doc["expenses"]) if x["id"] == expense_id), None)
    if pos is None: raise ApiError(404, "Expense not found.")
    cur = doc["expenses"][pos]
    if cur.get("installment"): raise ApiError(409, "This purchase is already split into installments. Merge it back first.")
    if not isinstance(items, list) or not 2 <= len(items) <= 120: raise ApiError(422, "Choose between 2 and 120 installments.")
    sign = 1 if cur["amount"] > 0 else -1
    group, made = str(uuid.uuid4()), []
    for k, it in enumerate(items):
        amt = it.get("amount") if isinstance(it, dict) else None
        if not isinstance(it, dict) or not valid_date(it.get("date")) or isinstance(amt, bool) or not isinstance(amt, (int, float)) or amt * sign <= 0 or round(amt, 2) != amt:
            raise ApiError(422, f"Installment {k + 1} needs a valid date and a non-zero amount with the same sign as the purchase.")
        e = copy.deepcopy(cur)
        if k:
            e["id"] = str(uuid.uuid4()); e["createdAt"] = now_iso(); e.pop("source", None)
        e.update(date=it["date"], amount=round(amt, 2), updatedAt=now_iso(),
                 installment={"groupId": group, "index": k + 1, "count": len(items), "purchaseDate": cur["date"]})
        made.append(e)
    doc["expenses"][pos:pos + 1] = made
    return made, f"Split {cur['merchant']} into {len(made)} installments"


def save(doc, label="Data changed"):
    """Validate, back up the current file, then write atomically. Bumps revision, records the change in the undo history.
    Returns a prompt warning or None."""
    errs = document_errors(doc)
    if errs:
        raise ApiError(422, "The change was rejected because it would make the data invalid.", errs[:10])
    doc["revision"] = int(doc.get("revision", 0)) + 1
    doc["updatedAt"] = now_iso()
    os.makedirs(BACKUPS, exist_ok=True)
    backup_name = None
    if os.path.exists(DATA):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_name = f"expenses-{stamp}-r{doc['revision'] - 1}.json.gz"
        with open(DATA, "rb") as src, open(os.path.join(BACKUPS, backup_name), "wb") as dst:
            dst.write(gzip.compress(src.read(), 9, mtime=0))
        keep = {h["backup"] for h in read_history()} | {backup_name}   # never delete a restore point that undo still needs
        old = [n for n in sorted(os.listdir(BACKUPS)) if n not in keep]
        for n in old[:max(0, len(old) - KEEP_BACKUPS)]:
            os.remove(os.path.join(BACKUPS, n))
    tmp = DATA + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, DATA)
    if backup_name:
        write_history([{"id": uuid.uuid4().hex[:12], "at": now_iso(), "label": str(label)[:140], "backup": backup_name}] + read_history())
    return " ".join(w for w in (write_prompt(doc), write_mobile(doc)) if w) or None


def check_revision(doc, body):
    if body.get("baseRevision") != doc.get("revision"):
        raise ApiError(409, "The data changed since you loaded it (for example from another device). Reload and try again.",
                       [{"currentRevision": doc.get("revision")}])


def clean_expense(src, existing=None):
    keys = ("date", "merchant", "amount", "currency", "category", "subcategory", "notes", "enteredDate",
            "receiptId", "receiptFile", "tripId")
    e = dict(existing or {})  # unknown fields on an existing record are preserved
    for k in keys:
        if k in src:
            e[k] = src[k]
    if e.get("tripId") == "": e["tripId"] = None
    if isinstance(e.get("merchant"), str): e["merchant"] = e["merchant"].strip()
    if isinstance(e.get("amount"), float): e["amount"] = round(e["amount"], 2)
    e.setdefault("subcategory", ""); e.setdefault("notes", "")
    return e


def is_duplicate(doc, e):
    keys = ("date", "merchant", "amount", "currency", "category", "subcategory")
    return any(all(x.get(k) == e.get(k) for k in keys) and (x.get("receiptId") == e.get("receiptId"))
               for x in doc["expenses"])


def roles_using(doc, cat, sub=None):
    return [k for k, r in doc.get("promptRoles", {}).items() if r["category"] == cat and (sub is None or r["subcategory"] == sub)]


def clean_trip(src):
    t = {"name": str(src.get("name") or "").strip(), "city": str(src.get("city") or "").strip(),
         "country": str(src.get("country") or "").strip(), "start": src.get("start"), "end": src.get("end")}
    if not t["name"] or not t["city"]: raise ApiError(422, "A trip needs a name and a city.")
    if len(t["name"]) > 80 or len(t["city"]) > 80 or len(t["country"]) > 80: raise ApiError(422, "Keep names under 80 characters.")
    if not valid_date(t["start"]) or not valid_date(t["end"]) or t["start"] > t["end"]:
        raise ApiError(422, "Use valid dates, with the start on or before the end.")
    return t


def apply_trip_op(doc, b):
    """Home city and trips. Returns the label for the undo history."""
    op, trips = b.get("op"), doc.setdefault("trips", [])
    if op == "setHomeCity":
        city = str(b.get("city") or "").strip()
        if not city or len(city) > 80: raise ApiError(422, "Enter your home city (up to 80 characters).")
        doc.setdefault("settings", {})["homeCity"] = city
        return f"Changed home city to {city}"
    if op == "addTrip":
        t = clean_trip(b.get("trip") or {}); t["id"] = uuid.uuid4().hex[:8]; trips.append(t)
        return f"Added trip {t['name']}"
    if op == "addTrips":
        new = [clean_trip(x) for x in (b.get("trips") or [])]
        if not new: raise ApiError(422, "There are no trips to add.")
        for t in new: t["id"] = uuid.uuid4().hex[:8]; trips.append(t)
        return f"Added {len(new)} {'trip' if len(new) == 1 else 'trips'}"
    t = next((x for x in trips if x["id"] == b.get("id")), None)
    if not t: raise ApiError(404, "Trip not found.")
    if op == "updateTrip":
        t.update(clean_trip(b.get("trip") or {}))
        return f"Edited trip {t['name']}"
    if op == "deleteTrip":
        n = 0
        for e in doc["expenses"]:
            if e.get("tripId") == t["id"]: e.pop("tripId"); n += 1
        trips.remove(t)
        return f"Deleted trip {t['name']}" + (f" (unassigned {n} expenses)" if n else "")
    raise ApiError(400, "Unknown operation.")


def apply_category_op(doc, b):
    op, cats = b.get("op"), doc["categories"]
    roles = doc.setdefault("promptRoles", {})
    find = lambda n: next((c for c in cats if c["name"] == n), None)
    name, cat = b.get("name"), b.get("category")
    if op == "addCategory":
        if not valid_name(name) or find(name): raise ApiError(422, "Enter a unique name starting with an uppercase letter.")
        cats.append({"name": name, "subcategories": []})
    elif op in ("renameCategory", "deleteCategory"):
        c = find(cat)
        if not c: raise ApiError(404, "Category not found.")
        used = [e for e in doc["expenses"] if e["category"] == cat]
        if op == "renameCategory":
            if not valid_name(name) or (find(name) and name != cat): raise ApiError(422, "Enter a unique name starting with an uppercase letter.")
            c["name"] = name
            for e in used: e["category"] = name
            for r in roles.values():
                if r["category"] == cat: r["category"] = name
        else:
            if roles_using(doc, cat):
                raise ApiError(409, f"'{cat}' is used by prompt rules ({', '.join(roles_using(doc, cat))}). Point those rules to another category first.")
            if used: raise ApiError(409, f"{len(used)} expenses use '{cat}'. Move them to another category first.")
            cats.remove(c)
    elif op in ("addSubcategory", "renameSubcategory", "deleteSubcategory"):
        c = find(cat)
        if not c: raise ApiError(404, "Category not found.")
        subs = c["subcategories"]
        if op == "addSubcategory":
            if not valid_name(name) or name in subs: raise ApiError(422, "Enter a unique name starting with an uppercase letter.")
            subs.append(name)
        else:
            old = b.get("subcategory")
            if old not in subs: raise ApiError(404, "Subcategory not found.")
            used = [e for e in doc["expenses"] if e["category"] == cat and e.get("subcategory") == old]
            if op == "renameSubcategory":
                if not valid_name(name) or (name in subs and name != old): raise ApiError(422, "Enter a unique name starting with an uppercase letter.")
                subs[subs.index(old)] = name
                for e in used: e["subcategory"] = name
                for r in roles.values():
                    if r["category"] == cat and r["subcategory"] == old: r["subcategory"] = name
                if old in c.get("subcategoryHints", {}): c["subcategoryHints"][name] = c["subcategoryHints"].pop(old)
                if old in c.get("subcategoryEmoji", {}): c["subcategoryEmoji"][name] = c["subcategoryEmoji"].pop(old)
            else:
                if roles_using(doc, cat, old):
                    raise ApiError(409, f"'{old}' is used by prompt rules ({', '.join(roles_using(doc, cat, old))}). Point those rules to another subcategory first.")
                c.get("subcategoryHints", {}).pop(old, None)
                c.get("subcategoryEmoji", {}).pop(old, None)
                if used: raise ApiError(409, f"{len(used)} expenses use '{old}'. Move them to another subcategory first.")
                subs.remove(old)
    elif op == "setHint":
        c = find(cat)
        if not c: raise ApiError(404, "Category not found.")
        hint, sub = (b.get("hint") or "").strip(), b.get("subcategory")
        if len(hint) > 400: raise ApiError(422, "Keep the description under 400 characters.")
        if sub:
            if sub not in c["subcategories"]: raise ApiError(404, "Subcategory not found.")
            hs = c.setdefault("subcategoryHints", {})
            if hint: hs[sub] = hint
            else: hs.pop(sub, None)
        elif hint: c["hint"] = hint
        else: c.pop("hint", None)
    elif op == "setEmoji":
        c = find(cat)
        if not c: raise ApiError(404, "Category not found.")
        em = (b.get("emoji") or "").strip()
        if len(em) > 10 or re.search(r"[A-Za-z0-9]", em): raise ApiError(422, "Use a single emoji.")
        if em: c["emoji"] = em
        else: c.pop("emoji", None)
    elif op == "setSubEmoji":
        c = find(cat); sub = b.get("subcategory")
        if not c or sub not in c["subcategories"]: raise ApiError(404, "Subcategory not found.")
        em = (b.get("emoji") or "").strip()
        if len(em) > 10 or re.search(r"[A-Za-z0-9]", em): raise ApiError(422, "Use a single emoji.")
        em_map = c.setdefault("subcategoryEmoji", {})
        if em: em_map[sub] = em
        else: em_map.pop(sub, None)
    elif op == "setRole":
        role, sub = b.get("role"), b.get("subcategory") or ""
        c = find(cat)
        if role not in ROLES or not c or (sub not in c["subcategories"] and not (role == "travel" and sub == "")):
            raise ApiError(422, "Choose an existing category and subcategory for this rule.")
        roles[role] = {"category": cat, "subcategory": sub}
    else:
        raise ApiError(400, "Unknown operation.")


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "ExpensesLocal/1"

    def log_message(self, fmt, *args):
        pass

    def _json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _origin_ok(self):
        o = self.headers.get("Origin")
        return o is None or urlparse(o).hostname in ("127.0.0.1", "localhost")

    def _static(self, base, rel, download=False):
        path = os.path.realpath(os.path.join(base, rel))
        if not path.startswith(os.path.realpath(base) + os.sep) or not os.path.isfile(path):
            return self._json(404, {"error": "Not found"})
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype.endswith(("javascript", "json")) else ""))
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with open(path, "rb") as f:
            while chunk := f.read(65536):
                self.wfile.write(chunk)

    def do_GET(self):
        if not self._host_ok():
            return self._json(403, {"error": "Forbidden host"})
        p = unquote(urlparse(self.path).path)
        try:
            if p == "/api/data":
                with LOCK:
                    return self._json(200, load())
            if p == "/api/history":
                with LOCK:
                    items = [h for h in read_history() if os.path.isfile(os.path.join(BACKUPS, h["backup"]))]
                return self._json(200, {"history": [{"id": h["id"], "at": h["at"], "label": h["label"]} for h in items]})
            if p == "/api/inbox":
                return self._json(200, inbox_status())
            if p == "/api/about":
                with LOCK:
                    return self._json(200, about_info(load()))
            if p == "/api/check":
                with LOCK:
                    return self._json(200, run_checks(load()))
            if p == "/api/changelog":
                try:
                    with open(os.path.join(ROOT, "CHANGELOG.md"), "rb") as f: body = f.read()
                except OSError:
                    body = b""
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            if p == "/api/version":
                try:
                    with open(os.path.join(ROOT, "VERSION"), encoding="utf-8") as f: v = f.read().strip()
                except OSError:
                    v = ""
                return self._json(200, {"version": v})
            if p == "/api/prompt":
                with open(PROMPT_OUT, "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            if p.startswith("/receipts/"):
                return self._static(RECEIPTS, p[len("/receipts/"):])
            return self._static(PUBLIC, "index.html" if p == "/" else p.lstrip("/"))
        except ApiError as ex:
            self._json(ex.status, {"error": ex.message, "details": ex.details})

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 5_000_000: raise ApiError(413, "Request too large.")
            return json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            raise ApiError(400, "Request body is not valid JSON.")

    def _upload(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0: raise ApiError(400, "No file was received.")
        if n > MAX_UPLOAD: raise ApiError(413, "The file is larger than 25 MB.")
        data = self.rfile.read(n)
        ext = sniff_ext(data)
        if not ext: raise ApiError(415, "Only images (JPG, PNG, WEBP, GIF, HEIC) and PDF files are allowed.")
        with LOCK:
            os.makedirs(RECEIPTS, exist_ok=True)
            stem, name = new_receipt_name(ext)
            tmp = os.path.join(RECEIPTS, "." + name + ".tmp")
            with open(tmp, "wb") as f:
                f.write(data); f.flush(); os.fsync(f.fileno())
            os.replace(tmp, os.path.join(RECEIPTS, name))
        self._json(200, {"receiptId": stem, "receiptFile": f"Receipts/{name}", "size": n})

    def _discard_upload(self, name):
        """Removes a just-uploaded, still unreferenced file (used when saving the expense failed). Never touches older receipts."""
        path = os.path.join(RECEIPTS, name)
        with LOCK:
            doc = load()
            referenced = any(e.get("receiptFile") == f"Receipts/{name}" for e in doc["expenses"])
            if not RECEIPT_NAME.match(name) or not os.path.isfile(path) or referenced or datetime.now().timestamp() - os.path.getmtime(path) > 1800:
                raise ApiError(409, "That file cannot be removed.")
            os.remove(path)
        self._json(200, {"deleted": True})

    def _mutate(self, method):
        if not self._host_ok() or not self._origin_ok() or self.headers.get("X-Requested-With") != "expenses-ui":
            raise ApiError(403, "Request rejected.")
        path = urlparse(self.path).path
        if path == "/api/receipts" and method == "POST": return self._upload()
        if path == "/api/inbox/import" and method == "POST": return self._json(200, process_inbox())
        if path.startswith("/api/receipts/") and method == "DELETE": return self._discard_upload(unquote(path.rsplit("/", 1)[1]))
        p, b = path, self._body()
        with LOCK:
            doc = load()
            check_revision(doc, b)
            result = {}
            label = "Data changed"
            post_save = None
            if p == "/api/expenses" and method == "POST":
                e = clean_expense(b.get("expense", {}))
                e.update({"id": str(uuid.uuid4()), "createdAt": now_iso(), "updatedAt": now_iso(),
                          "source": {"origin": "dashboard"}})
                e.setdefault("enteredDate", datetime.now().strftime("%Y-%m-%d"))
                e.setdefault("receiptId", None); e.setdefault("receiptFile", None)
                errs = expense_errors(e, doc["categories"], {t["id"] for t in doc.get("trips", [])})
                if errs: raise ApiError(422, "Please fix the highlighted fields.", errs)
                if not b.get("allowDuplicate") and is_duplicate(doc, e):
                    raise ApiError(409, "An identical expense already exists.", [{"duplicate": True}])
                doc["expenses"].append(e); result["expense"] = e
                label = f"Added expense: {e['merchant']}"
            elif p == "/api/expenses/batch" and method == "POST":
                ups = b.get("updates")
                if not isinstance(ups, list) or not ups or len(ups) > 5000:
                    raise ApiError(422, "There are no changes to save.")
                pos = {x["id"]: i for i, x in enumerate(doc["expenses"])}
                errs = []
                for u in ups:
                    if u.get("id") not in pos: raise ApiError(404, "One of the expenses no longer exists. Reload and try again.")
                    cur = doc["expenses"][pos[u["id"]]]
                    fields = {k: v for k, v in (u.get("set") or {}).items() if k in EDITABLE}
                    e = clean_expense(fields, cur)
                    bad = expense_errors(e, doc["categories"], {t["id"] for t in doc.get("trips", [])})
                    if bad:
                        errs += [{**x, "id": cur["id"], "message": f"{cur['merchant']} ({cur['date']}): {x['message']}"} for x in bad]
                        continue
                    e["updatedAt"] = now_iso()
                    doc["expenses"][pos[u["id"]]] = e
                if errs: raise ApiError(422, "Some changes are not valid, so nothing was saved.", errs[:10])
                result["updated"] = len(ups)
                label = f"Edited {len(ups)} {'row' if len(ups) == 1 else 'rows'} in the Data tab"
            elif p == "/api/installments" and method == "POST":
                made, label = apply_split(doc, b.get("expenseId"), b.get("installments"))
                result["created"] = len(made)
            elif p == "/api/installments/replace" and method == "POST":
                label = apply_replace_plan(doc, b.get("groupId"), b.get("installments"))
            elif p == "/api/installments/delete" and method == "POST":
                label = apply_delete_plan(doc, b.get("groupId"))
                result["deleted"] = True
            elif p == "/api/installments/merge" and method == "POST":
                members = [e for e in doc["expenses"] if (e.get("installment") or {}).get("groupId") == b.get("groupId")]
                if not members: raise ApiError(404, "Installment plan not found.")
                members.sort(key=lambda e: (e["date"], e["installment"].get("index", 0)))
                first = members[0]
                first["amount"] = round(sum(m["amount"] for m in members), 2)
                first["date"] = first["installment"].get("purchaseDate") or first["date"]
                first.pop("installment"); first["updatedAt"] = now_iso()
                drop = {m["id"] for m in members[1:]}
                doc["expenses"] = [e for e in doc["expenses"] if e["id"] not in drop]
                result["merged"] = len(members)
                label = f"Merged {len(members)} installments of {first['merchant']}"
            elif p.startswith("/api/expenses/") and method in ("PUT", "DELETE"):
                eid = p.rsplit("/", 1)[1]
                cur = next((x for x in doc["expenses"] if x["id"] == eid), None)
                if not cur: raise ApiError(404, "Expense not found.")
                if method == "DELETE":
                    doc["expenses"].remove(cur)
                    label = f"Deleted expense: {cur['merchant']} ({cur['date']})"
                else:
                    e = clean_expense(b.get("expense", {}), cur)
                    errs = expense_errors(e, doc["categories"], {t["id"] for t in doc.get("trips", [])})
                    if errs: raise ApiError(422, "Please fix the highlighted fields.", errs)
                    e["updatedAt"] = now_iso()
                    doc["expenses"][doc["expenses"].index(cur)] = e; result["expense"] = e
                    label = f"Edited expense: {e['merchant']}"
            elif p == "/api/categories" and method == "POST":
                apply_category_op(doc, b)
                label = describe_op(b)
            elif p == "/api/trips" and method == "POST":
                label = apply_trip_op(doc, b)
            elif p == "/api/undo" and method == "POST":
                hist = read_history()
                idx = next((i for i, h in enumerate(hist) if h["id"] == b.get("actionId")), None)
                if idx is None: raise ApiError(404, "That action is no longer in the history.")
                path = os.path.join(BACKUPS, hist[idx]["backup"])
                if not os.path.isfile(path): raise ApiError(410, "The restore point for this action is no longer available.")
                try:
                    snap = read_backup(path)
                except (OSError, EOFError, json.JSONDecodeError):
                    raise ApiError(500, "The restore point could not be read.")
                undone = hist[:idx + 1]
                snap["revision"] = doc["revision"]          # revisions only ever go forward
                ensure_defaults(snap)                       # older snapshots may lack fields added later
                doc = snap
                if len(undone) == 1 and undone[0]["label"].startswith("Undid"): label = "Redid the undone actions"
                elif len(undone) == 1: label = "Undid: " + undone[0]["label"]
                else: label = f"Undid {len(undone)} actions"
                result["undone"] = [h["label"] for h in undone]
                undone_ids = {h["id"] for h in undone}
                post_save = lambda: write_history([h for h in read_history() if h["id"] not in undone_ids])
            else:
                raise ApiError(404, "Not found.")
            warn = save(doc, label)
            if post_save: post_save()
            result.update(revision=doc["revision"], categories=doc["categories"], promptRoles=doc["promptRoles"], trips=doc.get("trips", []), settings=doc.get("settings", {}))
            if warn: result["promptWarning"] = warn
            self._json(200, result)

    def _do(self, method):
        try:
            self._mutate(method)
        except ApiError as ex:
            self._json(ex.status, {"error": ex.message, "details": ex.details})
        except Exception as ex:  # report, never crash silently
            self._json(500, {"error": f"Unexpected server error: {ex}"})

    def do_POST(self): self._do("POST")
    def do_PUT(self): self._do("PUT")
    def do_DELETE(self): self._do("DELETE")


def main():
    for stream in (sys.stdout, sys.stderr):  # a Windows console may not be UTF-8; never fail on a character in a message
        try: stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError): pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--empty", action="store_true", help="on the first run, start without the sample expenses and trips")
    a = ap.parse_args()
    if not os.path.isfile(DATA):  # first run: start from the sample data (replace it with your own in Settings)
        sample = os.path.join(ROOT, "examples", "sample-data.json")
        os.makedirs(os.path.dirname(DATA), exist_ok=True)
        with open(sample, encoding="utf-8") as f: sample_doc = json.load(f)
        if a.empty: sample_doc["expenses"] = []; sample_doc["trips"] = []
        with open(DATA, "w", encoding="utf-8") as f: json.dump(sample_doc, f, ensure_ascii=False, indent=2)
        print("First run: data/expenses.json created " + ("with the categories only (no expenses)." if a.empty else "from examples/sample-data.json."))
    with LOCK:  # one-time upgrade for older files, then (re)generate the prompt file
        n = migrate_backups()
        if n: print(f"Compressed {n} older backups in data/backups/.")
        doc = load()
        if ensure_defaults(doc):
            warn = save(doc, "Data upgrade")
            print("Data file upgraded with prompt rules (backup kept in data/backups/).")
        else:
            warn = " ".join(w for w in (write_prompt(doc), write_mobile(doc)) if w) or None
        if warn: print("WARNING:", warn)
    threading.Thread(target=inbox_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print(f"Expenses dashboard: http://127.0.0.1:{a.port}   (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
