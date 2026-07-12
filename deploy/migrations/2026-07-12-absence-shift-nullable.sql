-- absence_requests.shift is NULL for a whole-day-off request (scheduleGenerator treats a
-- NULL shift as "blocks every shift that day"; the Drizzle schema declares it nullable).
-- The Jul-3 schema.sql snapshot still had the column NOT NULL and no migration captured the
-- change, so a fresh deploy / CI-from-schema would reject whole-day absences. The live DB is
-- already nullable, so this is a no-op there and only corrects fresh loads.
ALTER TABLE absence_requests ALTER COLUMN shift DROP NOT NULL;
