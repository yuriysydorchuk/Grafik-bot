-- Привʼязка клієнтів до фабрик по ID (кінець матчингу по назвах у P&L):
-- client_nip — NIP юрособи-клієнта (ключ матчингу фактур KSeF);
-- pnl_label — канонічний підпис клієнта в P&L (кілька фабрик одного клієнта
-- діляться одним nip/label і зливаються в один рядок).
ALTER TABLE factories ADD COLUMN IF NOT EXISTS client_nip text;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS pnl_label text;

UPDATE factories SET client_nip = v.nip, pnl_label = v.lbl FROM (VALUES
  (13, '9462566686', 'Agram'),
  (12, '9462566686', 'Agram'),
  (4,  '5381579085', 'Allmiz'),
  (2,  '7160001727', 'Andros'),
  (19, '7261021513', 'Aunde'),
  (11, '7120153342', 'Bimiz'),
  (6,  '5262891379', 'Dezynfekcja'),
  (5,  '7162850732', 'Dorko'),
  (8,  '7791906082', 'Eurocash'),
  (17, '7791906082', 'Eurocash'),
  (9,  '7791906082', 'Eurocash'),
  (16, '6793108059', 'InPost'),
  (27, '6793108059', 'InPost'),
  (14, '9462337230', 'Kuźnia'),
  (1,  '7161006661', 'LST'),
  (22, '6793203869', 'NowoPak'),
  (24, '7322210155', 'Pak-Service'),
  (3,  '5060126084', 'Premium Fruits'),
  (21, '7773245581', 'Sushi&Food Factory'),
  (18, '7271883794', 'TOP-2')
) AS v(id, nip, lbl) WHERE factories.id = v.id;
