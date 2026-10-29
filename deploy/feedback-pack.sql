-- Пакет відкритих зголошень для тріажу (read-only; скіл /feedback-triage).
-- Запуск на проді: psql "$DATABASE_URL" -tA -f deploy/feedback-pack.sql > pack.json
-- Той самий зміст, що й ZIP з панелі (/feedback/admin/pack.zip), без файлів —
-- скріншоти/піни тягнуться окремо з uploads/feedback/ за полем attachments[].path.
-- Фільтр по статусах: відкриті (new…fixed). Для іншого набору — правити WHERE.
SELECT json_build_object(
  'generatedAt', now(),
  'count', count(*),
  'reports', coalesce(json_agg(r ORDER BY r.id DESC), '[]'::json)
)
FROM (
  SELECT
    f.id, f.kind, f.severity, f.status, f.title, f.description, f.steps, f.expected,
    json_build_object('path', f.page_path, 'label', f.page_label, 'url', f.page_url, 'filters', f.page_filters, 'aboutPage', f.about_page) AS page,
    f.origin, f.client_error AS "clientError", f.context, f.breadcrumbs, f.recorded,
    f.build_version AS "buildVersion",
    json_build_object('id', a.id, 'name', a.name, 'role', f.context->>'roleLabel') AS author,
    f.created_at AS "createdAt", f.reply, f.duplicate_of_id AS "duplicateOfId", f.task_id AS "taskId", f.triage,
    (SELECT count(*) FROM feedback_votes v WHERE v.report_id = f.id) AS votes,
    (SELECT coalesce(json_agg(json_build_object('id', at.id, 'kind', at.kind, 'path', at.path, 'name', at.name, 'mime', at.mime, 'meta', at.meta) ORDER BY at.id), '[]'::json)
       FROM feedback_attachments at WHERE at.report_id = f.id) AS attachments,
    (SELECT coalesce(json_agg(json_build_object('at', c.created_at, 'by', coalesce(ca.name, 'система'), 'kind', c.kind, 'via', c.via, 'body', c.body) ORDER BY c.id), '[]'::json)
       FROM feedback_comments c LEFT JOIN admins ca ON ca.id = c.admin_id WHERE c.report_id = f.id) AS comments
  FROM feedback_reports f
  LEFT JOIN admins a ON a.id = f.author_admin_id
  WHERE f.status IN ('new', 'review', 'clarify', 'planned', 'in_progress', 'fixed')
) r;
