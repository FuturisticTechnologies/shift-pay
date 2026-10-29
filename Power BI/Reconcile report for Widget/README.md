# August reconciliation toolkit
All figures in `sample_data/`, `output/`, the workbook and `powerbi/data/` are SAMPLE (synthetic) with planted discrepancies.

1. Export August report cost lines → `report_costs.csv` (line_id, cost_date, cost_centre, amount).
2. Export Manager Approval widget items → `widget_items.csv` (line_id, status, approved_date, amount, approver, cost_centre).
3. `python code/reconcile.py --report report_costs.csv --widget widget_items.csv --month 2026-08 --out output`
4. Excel: paste the same data into `excel/August_Reconciliation.xlsx` (Report_Data / Widget_Data) – Summary recalculates.
5. Power BI: refresh with the new `output/recon_lines.csv` (see `powerbi/04_REPORT_SPEC.md`).
Exit code is non-zero if any variance is unexplained.
