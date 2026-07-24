-- Ставка в профілі стає override-ом: NULL = «авто» за правилами фабрики
-- (пара посади factory_positions → найдешевша посада → базова пара фабрики).
-- Прибираємо NOT NULL і дефолт 31.5 (новий працівник — без ставки, авто).
ALTER TABLE workers ALTER COLUMN hourly_rate DROP NOT NULL;
ALTER TABLE workers ALTER COLUMN hourly_rate DROP DEFAULT;
