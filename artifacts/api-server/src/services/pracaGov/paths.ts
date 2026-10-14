// Шляхи робота praca.gov.pl: Chromium-профіль на акаунт (cookies сесії порталу).
import fs from "node:fs";
import path from "node:path";
import { UPLOADS_ROOT } from "../../lib/uploads";

export const PZ_PROFILES_DIR = path.join(UPLOADS_ROOT, "pz-profiles");
export const pzProfileDir = (accountId: number) => path.join(PZ_PROFILES_DIR, String(accountId));
// Стерти сесію порталу акаунта (зміна логіна/пароля, видалення акаунта): наступний запуск логіниться заново
export function resetPzProfile(accountId: number): void {
  fs.rmSync(pzProfileDir(accountId), { recursive: true, force: true });
}
