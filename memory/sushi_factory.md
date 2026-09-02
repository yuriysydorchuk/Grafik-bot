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

## 7. Integration with Svodni (Poznań), Stanowiska & Month Splitting (Segmentation)
- **Two-Way Synchronization (Worker Profile <-> Svodni Poznań <-> Sushi Module):**
  - **Worker Number:** `workers.workerCode` $\leftrightarrow$ `svodni_rows.hr.nrOsobowy` $\leftrightarrow$ `sushi_worker_codes.rcp_code`.
  - **Company / Firma:** `workers.companyId` (ES/ESO/Klinex) $\leftrightarrow$ `svodni_rows.hr.firma` $\leftrightarrow$ `sushi_worker_codes.firm`.
  - **Position / Stanowisko:** `workers.positionId` $\leftrightarrow$ `svodni_rows.section` (`hr.stanowisko`) $\leftrightarrow$ `sushi_roles` (linked via `position_id`).
- **Selective Rate Impact (Status Roles vs Regular Production):**
  - **Status Roles (`Lider`, `Brygadzista`, `Supervisor`):** Role directly dictates the pay rate (higher rate / status bonus). Changing to a status role updates the applicable rate.
  - **Regular Production Roles (`Pracownik`, `Skoczek`, `Оператор машини заморозки`, `Repack`):** Fixed for operational/line tracking, but pay rate stays standard factory base rate (rates do not change).
- **Mid-Month Role Promotion & Month Splitting (Segmentation):**
  - If a worker is promoted to `Lider` mid-month (e.g. from the 16th), `svodni` splits the row into 2 sub-segments:
    - **Segment 1 (01–15):** Stanowisko = `Pracownik` at base rate, with hours summed from `sushi_work_intervals` for dates 01–15.
    - **Segment 2 (16–30):** Stanowisko = `Lider` at leader rate, with hours summed from `sushi_work_intervals` for dates 16–30.
  - `attendanceByWindows` in `svodni.ts` fetches actual shift hours directly from `sushi_work_intervals` for Sushi factory.
  - `Załącznik do faktury` reflects the exact same split dates and rates for billing the client.

