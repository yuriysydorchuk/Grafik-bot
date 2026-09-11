-- Виповідзення по фабриці (11.09.2026): людина може піти з однієї фабрики/фірми, лишаючись
-- на решті. termination_factory_id: NULL = звільнення з усіх (як раніше); задано → у дату
-- termination_date закриваються лише умови цієї фабрики (zaświadczenie/wypowiedzenie тільки по
-- них), worker_factories.valid_to / зміна основної фабрики, ZUS ZWUA — лише якщо не лишається
-- чинної умови з тією ж фірмою (services/workerFire.ts endWorkerAtFactory).
ALTER TABLE workers ADD COLUMN IF NOT EXISTS termination_factory_id integer REFERENCES factories(id) ON DELETE SET NULL;
