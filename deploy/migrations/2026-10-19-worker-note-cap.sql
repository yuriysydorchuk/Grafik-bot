-- Примітка в профілі працівника — окремим правом workerNote (19.10.2026).
-- Досі читалась/писалась лише з svodniSensitive (закритий шар сводних: готівка,
-- księgowość, побажання по виплаті). Графіковому Євгенію (акаунт «Grafikowa 2»,
-- роль scheduler — єдиний активний у ролі) потрібна лише примітка.
-- Ідемпотентно: повторний прогін нічого не змінює.

UPDATE roles SET caps = caps || '["workerNote"]'::jsonb
WHERE key = 'scheduler' AND NOT caps ? 'workerNote';

UPDATE admins SET name = 'Графіковий Євгеній'
WHERE name = 'Grafikowa 2';
