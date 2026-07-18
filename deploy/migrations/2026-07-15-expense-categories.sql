-- Категорії витрат переїжджають із коду (bankClassify EXPENSE_CATS) у БД:
-- власник керує ними з веб-панелі (додати/перейменувати/видалити/патерн).
-- pattern — міні-DSL: кожен рядок — ОР-альтернатива; " + " в рядку — усі частини
-- мають збігтись (І); частина — Postgres regex по тексту транзакції (див.
-- bankClassify.ts patternCondition). NULL = категорія лише для ручного перенесення.
-- 'other' та owner_* — віртуальні ключі, в таблиці не живуть.

CREATE TABLE IF NOT EXISTS expense_categories (
    id serial PRIMARY KEY,
    key text NOT NULL UNIQUE,
    label text NOT NULL,
    pattern text,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL DEFAULT now()
);

-- Сід — історичний хардкод-список у тому самому порядку (пріоритет «перший збіг виграє»).
-- ON CONFLICT DO NOTHING: повторний прогін міграції не відкатує пізніші правки власника.
INSERT INTO expense_categories (key, label, pattern, sort_order) VALUES
  ('zus', 'ZUS', 'ZUS|ZAK.AD UB|SK.ADKA', 10),
  ('vat', 'Податки (VAT, US)', 'SKARBOW|/SFP/|VAT-7', 20),
  ('seizure', 'Зайняття (komornik)', 'EGZEKUC|KOMORNIK|ZAJ.CIE|CA. Z\.', 30),
  ('salary', 'Зарплати', 'WYNAGRODZ|PENSJ
RACHUNEK + UMOW', 40),
  ('zaliczki', 'Аванси (zaliczki)', 'ZALICZK', 50),
  ('fees', 'Комісії банку (перекази, вплати, зняття)', 'PROWIZ|PROW-PRZEL|C38|OP.ATA ZA PROWADZENIE|OP..MIES|OP.ATA MIESI|ZA OBS.UG|WEWN.TRZNE OBCI..ENIE|OP.ATA ZA PRZELEW|OP.ATA ZA RACHUNEK|GOONLINE', 60),
  ('fuel', 'Паливо', 'ORLEN|SHELL|CIRCLE K|LOTOS|MOYA|AMIC|PALIW|STACJA PALIW', 70),
  ('housing', 'Житло / готелі', 'BLUERENT|HOUSE POLAND|HOSTEL|GIMIK|BARTKOWIAK|ZALEWSKA|FSDW|NOCLEG|APART|MIESZKAN|CZYNSZ|NAJEM', 80),
  ('car_repair', 'Ремонт авто', 'TECHNO HOUSE|ANDRII BOIKO|BOIKO ANDRII', 90),
  ('office_rent', 'Оренда офісу', 'ODROW..-PIENI|PIENI..EK', 100),
  ('clothing', 'Одяг', '\yULAN\y', 110),
  ('multisport', 'Мультиспорт (Benefit)', 'BENEFIT', 120),
  ('trainer', 'Тренер (Palusiński)', 'PALUSI.SKI|PALUSINSKI', 130),
  ('leasing', 'Лізинг / авто', 'LEASING|VOLKSWAGEN|SANTANDER CONSUMER|AUDI|TOYOTA', 140),
  ('credit', 'Кредит', 'KREDYT|SP.ATA KAPITA|SP.ATA ODSET', 150),
  ('services', 'Послуги (бух., юристи)', 'TKM|RACHUNKOW|KANCELARIA|ADWOKA|NOTARI|ONESOFT|LUXMED|MEDYCZN', 160),
  ('marketing', 'Маркетинг', 'FB\.|FACEBOOK|FACEBK|GOOGLE|TIKTOK|OLX|FREELINE|META PLATFORM|OTOMOTO', 170),
  ('permits', 'Дозволи / уряд', 'WOJEWODZKI|WOJEW.DZKI|ZEZWOLEN|OP.ATA SKARBOWA', 180),
  ('b2b', 'Підрядники B2B', 'ANDROSHCHUK|SIMONIAN', 190),
  ('taxi', 'Таксі (Bolt, Uber)', '\yBOLT\y|BOLT\.EU|\yUBER\y|FREENOW|ITAXI', 200),
  ('travel', 'Подорожі / відрядження', 'AIRBNB|BOOKI|KIWI\.COM|GOTOGATE|RAINBOW|HOTEL|GETYOURGUIDE|RYANAIR|WIZZ|\yLOT\y|BKG-|ESKY|INTERCITY|BILET\.|DISCOVERCARS', 210),
  ('shops', 'Магазини (продукти)', 'ZABKA|.ABKA|BIEDRONKA|LIDL|AUCHAN|CARREFOUR|KAUFLAND|PEPCO|ACTION|DEALZ|STOKROTKA|LEWIATAN|TRANSGOURMET', 220),
  ('tech', 'Техніка / електроніка', 'X-KOM|MEDIA MARKT|MEDIA SATURN|EURO-NET|KOMPUTRONIK|SMARTSPOT|RTV EURO|APPLE|ALLEGRO', 230),
  ('household', 'Госптовари / буд', '\yOBI\y|BRICOMAN|CASTORAMA|LEROY|JYSK|IKEA|STALPOL|TEDI|SUPERHOBBY|DEDRA|DOMATOR|MAT[- ]?BUD|\yPSB\y|MR.WKA|BUDOWLAN|HURTOWNIA|MERKURY|BUDMAT', 240),
  ('card', 'Інші карткові', 'BEZGOT|KART. DEBET', 250)
ON CONFLICT (key) DO NOTHING;
