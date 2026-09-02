# Sushi & Food Factory (Domain Invariants)

## 1. Time Calculation & 15-Minute Rounding Laws
- **Start Time (Od):** Rounded **UP** (ceil) to the nearest 15 minutes (`06:01` -> `06:15`).
- **Stop Time (Do):** Rounded **DOWN** (floor) to the nearest 15 minutes (`14:14` -> `14:00`).
- **Night Shifts:** Interval cross-over midnight is fully supported (`22:00` -> `06:00` = 8.0h). Hours belong to the shift start date unless configured otherwise.
- **Excel Decimal Fractions:** Excel stores time as day fractions ($1.0 = 24\text{h}$). Numbers $< 1$ (e.g. `0.708333...`) must be normalized:
  - For OD/DO time: `(fraction * 24 * 60)` -> `HH:MM` (`17:00`).
  - For Realne godziny (Duration): `Math.round(fraction * 24 * 100) / 100` (`17.00h`).
  - Formatter `parseExcelHours()` in `sushiTime.ts` handles all fraction/string conversions.

## 2. Multi-Company & Contract Split
- **Factory Invoice (Załącznik do faktury):** Consolidated across the entire factory under legal entity **ESO** for client billing.
- **Worker Payroll:** Workers are assigned internally to **ES**, **ESO**, or **KLINEX** via `workers.company_id`. Payout limits and cash/bank splits follow their internal company profile.

## 3. Excel Import & Staging Gateway
- **Multi-file Upload:** Supports 1 to 50 Excel reports per batch.
- **FileList Snapshot:** Always capture `Array.from(e.target.files)` before resetting `e.target.value = ""` to avoid premature DOM collection clearing.
- **Visual Column Mapping Wizard (`ExcelMappingModal`):**
  - Allows previewing raw Excel sheets (lines 1..25) with column letters A, B, C...
  - Interactive assignment of columns: `RCP`, `OD`, `DO`, `Dział`, `Firma`, `Podpis`, `Realne godziny`, `Uwagi`.
  - Automatically formats time fractions into readable `HH:MM` and `X.XX год` in the preview table.
  - Passes explicit `mapping` JSON to `/sushi/import/upload`.

## 4. Timesheet & Historical Freezing
- **Rate Resolution:** Worker Override > Role Default > Factory Default. Rates are frozen into `sushi_work_intervals` snapshots upon staging approval.
- **Work Clothing (Odzież):** 6 zł/shift fee is deducted **exactly once per worker per day** on the first shift interval.

## 5. Hour Disputes & Disciplinary Penalties
- **Hour Disputes (Скарги по годинах):** Handled through `/sushi/disputes` tab.
- **Supervisor Fines:** When approving a dispute due to a leader's logging error, an optional penalty can be issued to `penalties` table referencing the supervisor.

## 6. Navigation & Submenu
- **Isolated Module:** Top horizontal tab bar removed. Replaced by a nested sidebar submenu under «Суші» in the left navigation panel (`/sushi`, `/sushi/timesheet`, `/sushi/disputes`, `/sushi/finance`, `/sushi/settings`).
- **Multi-language (i18n):** All submenu items and page headers are fully translated in `i18n.tsx` (`uk`, `en`, `ru`).
