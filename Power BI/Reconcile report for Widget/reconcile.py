#!/usr/bin/env python3
"""Reconcile a month of report cost lines against Manager Approval widget items.

Usage:
  python reconcile.py --report report_costs.csv --widget widget_items.csv --month 2026-08 --out ../output

Input columns (rename with --*-col flags if yours differ):
  report : line_id, cost_date, cost_centre, amount
  widget : line_id, status, approved_date, amount, [approver, cost_centre]

Definitions (change here if the widget defines its total differently):
  Report total = sum(amount) of report lines whose cost_date falls in the month.
  Widget total = sum(amount) of widget rows with status == --widget-status AND approved_date in the month.
  Variance     = Report total - Widget total, fully attributed to per-line categories (nothing unexplained).
Stdlib only; money handled with Decimal.
"""
import argparse, csv, datetime as dt, pathlib
from collections import defaultdict
from decimal import Decimal as D

TOL = D("0.005")


def read(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def month_range(m):
    y, mo = map(int, m.split("-"))
    start = dt.date(y, mo, 1)
    end = (dt.date(y + (mo == 12), mo % 12 + 1, 1) - dt.timedelta(days=1))
    return start, end


def parse_date(s):
    return dt.date.fromisoformat(s.strip()) if s and s.strip() else None


def reconcile(report, widget, month, widget_status="Approved"):
    start, end = month_range(month)
    in_m = lambda d: d is not None and start <= d <= end

    w_by_id = defaultdict(list)
    for r in widget:
        w_by_id[r["line_id"]].append(r)
    report_ids = {r["line_id"] for r in report}

    def counted(r):
        return D(r["amount"]) if (r["status"] == widget_status and in_m(parse_date(r["approved_date"]))) else D(0)

    lines = []
    for r in report:
        amt, d = D(r["amount"]), parse_date(r["cost_date"])
        rows = w_by_id.get(r["line_id"], [])
        L = sum((counted(w) for w in rows), D(0))
        inm = in_m(d)
        if inm and L > 0 and abs(amt - L) < TOL: cat = "Matched"
        elif inm and L > 0: cat = "Amount differs"
        elif inm and not rows: cat = "Missing in widget"
        elif inm and rows[0]["status"] != widget_status: cat = "In widget - not approved"
        elif inm: cat = "In widget - approved in other month"
        elif L > 0: cat = "Counted by widget - cost dated other month"
        else: cat = "Out of month - not in widget"
        lines.append(dict(side="Report", line_id=r["line_id"], cost_date=r["cost_date"], cost_centre=r["cost_centre"],
                          report_amount=amt if inm else D(0), widget_amount=L, variance=(amt if inm else D(0)) - L,
                          category=cat, widget_rows=len(rows), duplicate_in_widget=len(rows) > 1))
    for r in widget:
        if r["line_id"] in report_ids:
            continue
        L = counted(r)
        if L > 0:
            lines.append(dict(side="Widget", line_id=r["line_id"], cost_date="", cost_centre=r.get("cost_centre", ""),
                              report_amount=D(0), widget_amount=L, variance=-L, category="Widget-only - not in report",
                              widget_rows=1, duplicate_in_widget=False))
    for l in lines:
        l["month"] = month
    return lines


def summarise(lines):
    agg = defaultdict(lambda: [0, D(0), D(0), D(0)])
    for l in lines:
        a = agg[l["category"]]
        a[0] += 1; a[1] += l["report_amount"]; a[2] += l["widget_amount"]; a[3] += l["variance"]
    return agg


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--report", required=True); p.add_argument("--widget", required=True)
    p.add_argument("--month", required=True, help="YYYY-MM"); p.add_argument("--out", default="output")
    p.add_argument("--widget-status", default="Approved")
    a = p.parse_args()

    lines = reconcile(read(a.report), read(a.widget), a.month, a.widget_status)
    agg = summarise(lines)
    rt = sum((l["report_amount"] for l in lines), D(0)); wt = sum((l["widget_amount"] for l in lines), D(0))
    var = sum((l["variance"] for l in lines), D(0))
    unexplained = (rt - wt) - var

    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    cols = ["month", "side", "line_id", "cost_date", "cost_centre", "report_amount", "widget_amount", "variance",
            "category", "widget_rows", "duplicate_in_widget"]
    with open(out / "recon_lines.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(lines)
    with open(out / "recon_summary.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["month", "category", "lines", "report_amount", "widget_amount", "variance"])
        for c, (n, r, wd, v) in sorted(agg.items()):
            w.writerow([a.month, c, n, r, wd, v])

    print(f"Reconciliation {a.month}   (widget counts status='{a.widget_status}' by approval date)")
    print(f"  Report total : {rt:>12,.2f}\n  Widget total : {wt:>12,.2f}\n  Variance     : {rt - wt:>12,.2f}")
    print(f"  Unexplained  : {unexplained:>12,.2f}  <- must be 0.00\n")
    for c, (n, r, wd, v) in sorted(agg.items()):
        print(f"  {c:<45}{n:>4} lines  variance {v:>10,.2f}")
    dups = [l["line_id"] for l in lines if l["duplicate_in_widget"]]
    if dups: print("\n  Duplicate widget rows for:", ", ".join(dups))
    if unexplained != 0: raise SystemExit("Unexplained variance - investigate")


if __name__ == "__main__":
    main()
