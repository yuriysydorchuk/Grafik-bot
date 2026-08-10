-- Лізинг авто: умови договору на картці авто + привʼязка лізингових фактур
-- (дзеркало invoices.hostel_id): фактури «падають» на авто, картка показує
-- виплачено/залишок. Авто-привʼязку веде синк за lease_lessor(+contract_no).

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS lease_total real;        -- повна вартість договору, зл (owner-only)
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS lease_lessor text;       -- лізингодавець (нормалізований матч контрагента фактур)
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS lease_contract_no text;  -- № договору (розрізняє авто в одного лізингодавця)

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vehicle_id integer REFERENCES vehicles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS invoices_vehicle_idx ON invoices (vehicle_id);

-- Особисті авто власників (M8, Audi A6 ×2, CUPRA, Jaguar): в парку для документів
-- і лізингів, але поза робочим флоу і поза підсумком вартості робочого парку.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS personal boolean NOT NULL DEFAULT false;

-- Вартість лізингового авто для підсумку парку = wstępna + сплачені рати.
-- lease_initial_paid = wstępna брутто, ЯКЩО її фактури нема в реєстрі (тоді
-- вона додається до привʼязаних оплат; якщо фактура є і привʼязана — NULL).
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS lease_initial_paid real;
