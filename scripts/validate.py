#!/usr/bin/env python3
"""Validate data/expenses.json (the same checks as Settings > Data & storage > Run integrity check).

Usage: python3 scripts/validate.py
Exit code 0 = all checks passed.
"""
import json, os, sys

sys.dont_write_bytecode = True   # do not leave a __pycache__ folder in the project

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402


def main():
    with open(server.DATA, encoding="utf-8") as f:
        doc = json.load(f)
    res = server.run_checks(doc)
    for c in res["checks"]:
        print(("PASS " if c["ok"] else "FAIL ") + c["name"] + (f" - {c['detail']}" if c["detail"] else ""))
    i = res["info"]
    print(f"INFO files in Receipts/ not linked to any expense: {i['filesNotLinked']} (normal after unlinking a receipt)")
    print(f"INFO expenses: {len(doc['expenses'])}; refunds: {sum(1 for e in doc['expenses'] if e['amount'] < 0)}; empty subcategory: {sum(1 for e in doc['expenses'] if not e['subcategory'])}")
    sys.exit(0 if all(c["ok"] for c in res["checks"]) else 1)


if __name__ == "__main__":
    main()
