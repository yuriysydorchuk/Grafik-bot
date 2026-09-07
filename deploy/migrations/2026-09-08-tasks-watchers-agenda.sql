-- Модуль «Задачі», звірка з макетом (блок A+B, 08.09.2026):
-- спостерігачі (task_assignees.status='watcher'), вкладення в коментарях, порядок денний і
-- підсумок зустрічі.
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agenda jsonb NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS summary text;
