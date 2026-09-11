-- «Доїжджає сам» по фабриці й поденно (11.09.2026): інтервали [since, until)
-- для пари працівник+фабрика замість одного прапорця на профілі. Сід — чинні
-- прапорці переносяться на основну фабрику працівника; легасі-колонки
-- workers.self_transport(_since) лишаються, але код їх більше не читає.
CREATE TABLE IF NOT EXISTS worker_self_transport (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  factory_id integer NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  since date NOT NULL,
  until date,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_self_transport_pair_idx ON worker_self_transport (worker_id, factory_id);

-- одноразовий сід (ідемпотентно: лише якщо таблиця ще порожня). Два випадки за
-- старою помісячною семантикою: увімкнено (з дати або з давніх часів — відкритий
-- інтервал) і «вимкнено з датою» (до цієї дати людина була self — закритий
-- інтервал, щоб перерахунок минулих місяців не змінив результат).
INSERT INTO worker_self_transport (worker_id, factory_id, since, until)
SELECT w.id, w.factory_id,
       CASE WHEN w.self_transport THEN COALESCE(w.self_transport_since, DATE '2000-01-01') ELSE DATE '2000-01-01' END,
       CASE WHEN w.self_transport THEN NULL ELSE w.self_transport_since END
FROM workers w
WHERE w.factory_id IS NOT NULL
  AND (w.self_transport = true OR w.self_transport_since IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM worker_self_transport);
