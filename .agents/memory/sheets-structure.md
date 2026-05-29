---
name: Google Sheets form response structure
description: Exact column layout and value format for the worker availability Google Form responses
---

Sheet name: "Ответы на форму (1)"

Columns (0-indexed):
- 0: Timestamp (Excel serial number or date string)
- 1: Week date range — format "28.07.2025 - 03.08.2025" (first date = Monday)
- 2: Gender
- 3: "Surname Name" combined full name — USE THIS for worker matching
- 4: Surname only
- 5: First name only
- 6: Monday availability
- 7: Tuesday availability
- 8: Wednesday availability
- 9: Thursday availability
- 10: Friday availability
- 11: Saturday availability
- 12: Sunday availability

Shift values:
- "1 shift (8h)" → shift 1 (6:00–14:00)
- "2 shift (8h)" → shift 2 (14:00–22:00)
- "3 shift (8h)" → shift 3 (22:00–6:00)
- "day off" or "" → not available

**Why:** Column headers are trilingual (Ukrainian/Russian/English), matching by keyword is more robust than fixed index.
**How to apply:** In sheets.ts, detect day columns by searching for "monday", "понед", etc. in headers. Fall back to cols 6-12 if no match.

Service account: grafik@grafik-bot-497821.iam.gserviceaccount.com
The real production sheet ID is stored in GOOGLE_SHEETS_ID secret (not hardcoded).
The second example spreadsheet (1pSN6jIqKFOJCl24QdDU...) was NOT shared with the service account.
