// Одноразовий сідер для ручного тестування модуля «Документи й підписання».
// Запуск: node --env-file=.env ./scratch-seed-worker-docs.mjs
// (з кореня artifacts/api-server, .env має вказувати на ТВОЮ локальну dev-БД)
import { seedTestTemplateSet, generateTestCompanyStamp } from "./src/services/testTemplateFixtures.ts";
import { ensureUploadDirs } from "./src/lib/uploads.ts";

ensureUploadDirs();
const { setId, templateIds } = await seedTestTemplateSet();
console.log(`✅ Тестовий набір шаблонів засіджено: templateSetId=${setId}, файлів=${templateIds.length}`);
console.log("Тепер у веб-панелі профіль працівника → «Умови» → «Нова умова» покаже цей набір у списку.");

const stampPath = await generateTestCompanyStamp();
console.log(`✅ Тестова печатка фірми згенерована: ${stampPath}`);
console.log(`Додай у .env: COMPANY_STAMP_PNG=${stampPath}`);
console.log("(перезапусти api-server dev-сервер після цього — env читається лише при старті)");
process.exit(0);
