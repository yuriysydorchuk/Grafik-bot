-- Дірка ревʼю розблокування: критерій «createdAt > lockedAt поточного лока»
-- ховав незастосовані зміни, зроблені під СТАРІШИМ локом, який потім замінили
-- (перелочування). Відхилення тепер явний маркер, а не «випало з вікна часу».
ALTER TABLE worker_changes ADD COLUMN IF NOT EXISTS review_dismissed_at timestamp;
