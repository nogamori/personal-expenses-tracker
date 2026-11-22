#!/usr/bin/env python3
"""Tests for the server. Runs on a temporary copy of the project (your data, Receipts and Inbox are never touched).

Usage: python3 scripts/test.py
Exit code 0 = everything passed.
"""
import gzip, http.client, json, os, shutil, subprocess, sys, tempfile, time, uuid

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8790 + os.getpid() % 100
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f" - {detail}" if detail and not ok else ""))


class Server:
    def __init__(self, tmp):
        self.tmp = tmp
        self.proc = subprocess.Popen([sys.executable, "-B", os.path.join(tmp, "server.py"), "--port", str(PORT)],
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=tmp)
        for _ in range(60):
            try:
                self.get("/api/version"); return
            except OSError:
                time.sleep(0.2)
        raise RuntimeError("the test server did not start")

    def raw(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=15)
        h = {"Content-Type": "application/json", "X-Requested-With": "expenses-ui"}
        h.update(headers or {})
        if headers and headers.get("Host") == "": h.pop("Host", None)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
        r = c.getresponse(); data = r.read(); c.close()
        return r.status, data

    def call(self, method, path, body=None, headers=None):
        st, data = self.raw(method, path, body, headers)
        try: j = json.loads(data)
        except ValueError: j = {}
        j["_status"] = st
        return j

    def get(self, path): return self.call("GET", path)
    def data(self): return self.get("/api/data")
    def stop(self):
        self.proc.terminate()
        try: self.proc.wait(5)
        except subprocess.TimeoutExpired: self.proc.kill()

    def refused(self, name):
        """True when the file was refused: it is in Inbox/Failed with an explanation (and no longer in Inbox)."""
        d = os.path.join(self.tmp, "Inbox")
        return (os.path.exists(os.path.join(d, "Failed", name + ".error.txt")) or any(f.endswith(name + ".error.txt") for f in os.listdir(os.path.join(d, "Failed")))) and not os.path.exists(os.path.join(d, name))

    def inbox(self, request, name=None):
        name = name or request["editId"] + ".txt"
        with open(os.path.join(self.tmp, "Inbox", name), "w", encoding="utf-8") as f: f.write(request if isinstance(request, str) else json.dumps(request))
        time.sleep(3.3)   # the server waits a few seconds for a file to be complete
        return self.call("POST", "/api/inbox/import", {})


def req(**kw):
    r = {"kind": "expense-edit", "editId": uuid.uuid4().hex[:16]}; r.update(kw); return r


def main():
    tmp = tempfile.mkdtemp(prefix="expenses-test-")
    try:
        shutil.copytree(ROOT, tmp, dirs_exist_ok=True, ignore=shutil.ignore_patterns("Receipts", "Inbox", "Mobile", "__pycache__", ".DS_Store", "*.shortcut"))
        for d in ("Receipts", "Inbox/Processed", "Inbox/Failed", "Mobile", "data/backups"): os.makedirs(os.path.join(tmp, d), exist_ok=True)
        # no backups from the real project: the test starts with a clean history
        for n in ("history.json", "applied-edits.json"):
            p = os.path.join(tmp, "data", n)
            if os.path.exists(p): os.remove(p)
        srv = Server(tmp)
        try:
            run(srv, tmp)
        finally:
            srv.stop()
        # restore a backup the way the README describes
        restore(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    ok = all(RESULTS)
    print(f"\n{sum(RESULTS)} of {len(RESULTS)} checks passed" + ("" if ok else " - SOME FAILED"))
    sys.exit(0 if ok else 1)


def run(srv, tmp):
    d = srv.data(); E = d["expenses"]; rev = d["revision"]
    check("The server starts and serves the data", d["_status"] == 200 and len(E) > 0)
    check("Every expense has an id and a version (updatedAt)", all(e.get("id") and e.get("updatedAt") for e in E))

    # ---------- security ----------
    st, _ = srv.raw("GET", "/api/data", headers={"Host": "evil.example"})
    check("A foreign Host header is refused", st == 403, st)
    st, _ = srv.raw("POST", "/api/expenses", {"expense": {}, "baseRevision": rev}, headers={"X-Requested-With": ""})
    check("A change without the app header is refused", st == 403, st)
    st, _ = srv.raw("POST", "/api/expenses", {"expense": {}, "baseRevision": rev}, headers={"Origin": "http://evil.example"})
    check("A change from a foreign Origin is refused", st == 403, st)
    for p in ("/receipts/../server.py", "/receipts/%2e%2e/server.py", "/receipts/..%2fdata%2fexpenses.json", "/../server.py"):
        st, body = srv.raw("GET", p)
        check(f"Path traversal is refused ({p})", st in (400, 403, 404) and b"def main" not in body, st)

    # ---------- validation of a new expense ----------
    cat = next(c for c in d["categories"] if c["subcategories"])
    good = {"date": "2026-10-20", "merchant": "TEST merchant", "amount": 12.5, "currency": "EUR", "category": cat["name"], "subcategory": cat["subcategories"][0], "notes": ""}
    for label, change in (("zero amount", {"amount": 0}), ("bad date", {"date": "2026-02-31"}), ("unknown category", {"category": "Nope"}), ("empty merchant", {"merchant": " "}), ("bad currency", {"currency": "EURO"})):
        r = srv.call("POST", "/api/expenses", {"expense": {**good, **change}, "baseRevision": srv.data()["revision"]})
        check(f"Invalid expense refused ({label})", r["_status"] in (400, 422), r["_status"])
    r = srv.call("POST", "/api/expenses", {"expense": good, "baseRevision": 0})
    check("A change on an out-of-date page is refused", r["_status"] == 409, r["_status"])

    # ---------- the inbox: receipts from the Shortcut ----------
    rid = "20261020_101010"
    open(os.path.join(tmp, "Receipts", rid + ".jpg"), "wb").write(b"\xff\xd8\xff" + b"0" * 5000)
    body = {"receiptId": rid, "entries": [
        {"date": "20/10/2026", "merchant": "Test Shop", "amount": "4,50", "currency": "€", "category": "food", "subcategory": "GROCERIES", "trip": "", "notes": "Paid with card 4111 1111 1111 1111"},
        {"date": "2026-10-20", "merchant": "Test Shop", "amount": "9.00", "currency": "EUR", "category": "Made Up", "subcategory": "", "trip": "", "notes": ""}]}
    n0 = len(srv.data()["expenses"])
    srv.inbox("```json\n" + json.dumps(body) + "\n```", rid + ".txt")
    new = [e for e in srv.data()["expenses"] if e.get("receiptId") == rid]
    check("A receipt file is imported (lenient JSON, comma amounts, day-first dates, symbols)", len(new) == 2, len(new))
    a = next((e for e in new if e["amount"] == 4.5), {})
    check("Values are normalised (date, amount, currency, category case)", a.get("date") == "2026-10-20" and a.get("currency") == "EUR" and a.get("category") == "Food" and a.get("subcategory") == "Groceries", a)
    check("Card numbers are masked", "4111 1111 1111 1111" not in (a.get("notes") or ""), a.get("notes"))
    b = next((e for e in new if e["amount"] == 9.0), {})
    check("An unknown category goes to Other > Unclassified with a note", b.get("category") == "Other" and "Made Up" in (b.get("notes") or ""), b)
    check("The receipt file is linked", a.get("receiptFile") == f"Receipts/{rid}.jpg", a.get("receiptFile"))
    srv.inbox(json.dumps(body), rid + "-again.txt")
    check("The same receipt sent twice is not imported twice", len([e for e in srv.data()["expenses"] if e.get("receiptId") == rid]) == 2)
    srv.inbox("hello", "junk.txt")
    check("A file that is not JSON goes to Failed with an explanation", srv.refused("junk.txt"))
    srv.inbox('{"x":"' + "a" * 1_100_000 + '"}', "huge.txt")
    check("A file larger than 1 MB is refused without being read", srv.refused("huge.txt"))

    # ---------- the inbox: edit, delete, split and delete-plan from the phone ----------
    E = srv.data()["expenses"]
    plain = [e for e in E if not e.get("installment") and e["currency"] == "EUR" and e["date"] >= "2026-09-01" and e["amount"] > 5 and e.get("receiptId") != rid]
    x, y, z, w = plain[0], plain[1], plain[2], plain[3]
    r1 = req(action="edit", expenseId=x["id"], base=x["updatedAt"], changes={"merchant": "  Edited  ", "amount": "12,34", "notes": "from phone"})
    srv.inbox(r1); got = next(e for e in srv.data()["expenses"] if e["id"] == x["id"])
    check("An edit from the phone is applied", got["merchant"] == "Edited" and got["amount"] == 12.34 and got["notes"] == "from phone", got)
    srv.inbox(r1, "again.txt")
    check("The same edit sent twice is applied once", next(e for e in srv.data()["expenses"] if e["id"] == x["id"])["amount"] == 12.34 and not os.path.exists(os.path.join(tmp, "Inbox", "again.txt")))
    r = req(action="edit", expenseId=x["id"], base=x["updatedAt"], changes={"notes": "stale"}); srv.inbox(r)
    check("An edit on an out-of-date expense is refused", srv.refused(r["editId"] + ".txt") and next(e for e in srv.data()["expenses"] if e["id"] == x["id"])["notes"] == "from phone")
    r = req(action="edit", expenseId=y["id"], base=y["updatedAt"], changes={"receiptFile": "Receipts/x.pdf"}); srv.inbox(r)
    check("An edit of a field that is not allowed is refused", srv.refused(r["editId"] + ".txt") and next(e for e in srv.data()["expenses"] if e["id"] == y["id"]).get("receiptFile") == y.get("receiptFile"))
    r = req(action="edit", expenseId=y["id"], base=y["updatedAt"], changes={"category": "Nope"}); srv.inbox(r)
    check("An edit to a category that does not exist is refused", srv.refused(r["editId"] + ".txt") and next(e for e in srv.data()["expenses"] if e["id"] == y["id"])["category"] == y["category"])
    srv.inbox(req(action="delete", expenseId=z["id"], base=z["updatedAt"]))
    check("A delete from the phone is applied", not any(e["id"] == z["id"] for e in srv.data()["expenses"]))
    total = w["amount"]; part = round(total / 3, 2); first = round(total - 2 * part, 2)
    items = [{"date": "2026-10-20", "amount": first}, {"date": "2026-11-20", "amount": part}, {"date": "2026-12-20", "amount": part}]
    srv.inbox(req(action="split", expenseId=w["id"], base=w["updatedAt"], installments=items))
    plan = [e for e in srv.data()["expenses"] if (e.get("installment") or {}).get("purchaseDate") == w["date"] and e["merchant"] == w["merchant"] and e["notes"] == w["notes"] and e["date"] in ("2026-10-20", "2026-11-20", "2026-12-20")]
    check("A split from the phone creates the installments and the sum matches", len(plan) == 3 and round(sum(e["amount"] for e in plan), 2) == total, [e["amount"] for e in plan])
    gid = plan[0]["installment"]["groupId"] if plan else ""
    ip = next(e for e in srv.data()["expenses"] if e["id"] == plan[1]["id"]) if plan else {}
    r = req(action="delete", expenseId=ip.get("id", "?"), base=ip.get("updatedAt")); srv.inbox(r)
    check("Deleting one installment from the phone is refused", srv.refused(r["editId"] + ".txt") and any(e["id"] == ip.get("id") for e in srv.data()["expenses"]))
    members = lambda: [{"id": e["id"], "base": e["updatedAt"]} for e in srv.data()["expenses"] if (e.get("installment") or {}).get("groupId") == gid]
    stale = members()
    srv.call("PUT", "/api/expenses/" + plan[2]["id"], {"expense": {"notes": "edited on the Mac"}, "baseRevision": srv.data()["revision"]})
    r = req(action="delete-plan", groupId=gid, members=stale); srv.inbox(r)
    check("Deleting a plan that changed on the Mac is refused", srv.refused(r["editId"] + ".txt") and len(members()) == 3)
    srv.inbox(req(action="delete-plan", groupId=gid, members=members()))
    check("Deleting a whole plan from the phone removes every installment", len(members()) == 0)

    # ---------- the dashboard API: split, edit plan, delete plan, undo ----------
    E = srv.data()["expenses"]
    v = next(e for e in E if not e.get("installment") and e["currency"] == "EUR" and e["amount"] > 20)
    its = [{"date": f"2027-0{k + 1}-10", "amount": round(v["amount"] / 4, 2)} for k in range(3)]
    its.append({"date": "2027-04-10", "amount": round(v["amount"] - 3 * round(v["amount"] / 4, 2), 2)})
    r = srv.call("POST", "/api/installments", {"expenseId": v["id"], "installments": its, "baseRevision": srv.data()["revision"]})
    check("The dashboard can split a purchase", r["_status"] == 200 and r.get("created") == 4, r)
    r = srv.call("POST", "/api/installments", {"expenseId": v["id"], "installments": its, "baseRevision": srv.data()["revision"]})
    check("An expense that is already split cannot be split again", r["_status"] == 409, r["_status"])
    g2 = next(e for e in srv.data()["expenses"] if e["id"] == v["id"])["installment"]["groupId"]
    plan2 = lambda: [e for e in srv.data()["expenses"] if (e.get("installment") or {}).get("groupId") == g2]
    ids0 = [e["id"] for e in sorted(plan2(), key=lambda e: e["installment"]["index"])]
    two = [{"date": "2027-05-10", "amount": 10}, {"date": "2027-06-10", "amount": 20}]
    r = srv.call("POST", "/api/installments/replace", {"groupId": g2, "installments": two, "baseRevision": srv.data()["revision"]})
    p = sorted(plan2(), key=lambda e: e["installment"]["index"])
    check("Edit plan changes the number, dates and amounts and keeps the first records", r["_status"] == 200 and [e["id"] for e in p] == ids0[:2] and [e["amount"] for e in p] == [10, 20], r)
    r = srv.call("POST", "/api/installments/replace", {"groupId": g2, "installments": [two[0]], "baseRevision": srv.data()["revision"]})
    check("Edit plan with one installment is refused", r["_status"] in (400, 422), r["_status"])
    hist = srv.get("/api/history")["history"]
    last = next(h for h in hist if h["label"].startswith("Edited the installment plan"))
    n_before = len(srv.data()["expenses"])
    srv.call("POST", "/api/undo", {"actionId": last["id"], "baseRevision": srv.data()["revision"]})
    check("Undo restores the plan as it was", len(plan2()) == 4 and len(srv.data()["expenses"]) == n_before + 2)
    r = srv.call("POST", "/api/installments/delete", {"groupId": g2, "baseRevision": srv.data()["revision"]})
    check("Delete all installments removes the plan", r["_status"] == 200 and len(plan2()) == 0, r)

    # ---------- integrity and backups ----------
    chk = srv.get("/api/check")
    failed = [c["name"] for c in chk.get("checks", []) if not c["ok"] and "receipt file exists" not in c["name"]]   # the test copy has no Receipts folder
    check("The integrity checks pass after all these changes", not failed, failed)
    names = os.listdir(os.path.join(tmp, "data", "backups"))
    check("Backups are compressed (.json.gz) and each can be read", names and all(n.endswith(".json.gz") for n in names) and all(json.load(gzip.open(os.path.join(tmp, "data", "backups", n), "rt", encoding="utf-8")) for n in names[:5]), names[:3])
    check("Applied edit ids are remembered", len(json.load(open(os.path.join(tmp, "data", "applied-edits.json")))) >= 4)
    page = open(os.path.join(tmp, "Mobile", "expenses.html"), encoding="utf-8").read()
    check("The mobile page is regenerated with the ids and the plan ids", "const DATA = {" in page and '"rows":[["' in page)


def restore(tmp):
    """The manual recovery in the README: unzip a backup over expenses.json, start the server, the data is back."""
    bdir = os.path.join(tmp, "data", "backups")
    oldest = sorted(os.listdir(bdir))[0]
    snap = json.load(gzip.open(os.path.join(bdir, oldest), "rt", encoding="utf-8"))
    with open(os.path.join(tmp, "data", "expenses.json"), "w", encoding="utf-8") as f: json.dump(snap, f, ensure_ascii=False, indent=1)
    for n in ("history.json",):
        p = os.path.join(tmp, "data", n)
        if os.path.exists(p): os.remove(p)
    srv = Server(tmp)
    try:
        d = srv.data()
        check("A backup restored by hand makes the server start with that data", d["_status"] == 200 and d["revision"] == snap["revision"] and len(d["expenses"]) == len(snap["expenses"]), d.get("revision"))
        chk = srv.get("/api/check")
        check("The restored data passes the integrity checks", all(c["ok"] for c in chk["checks"] if "receipt file exists" not in c["name"]))
    finally:
        srv.stop()


if __name__ == "__main__":
    main()
