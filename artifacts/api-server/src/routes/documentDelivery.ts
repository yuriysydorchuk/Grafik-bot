// «Надіслати працівнику» для документів профілю й файлів умов (Telegram / email)
// + довідка «куди можемо» для модалки. Гейти per-route (не голий router.use).
// Кожна відправка — у журнал: document_audit (action=sent) або signature_events
// (event=file_sent) — хто, куди, коли.
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, workerDocumentsTable, contractsTable, contractFilesTable, signatureEventsTable } from "@workspace/db";
import { authRequired, requireCap, requireAnyCap, type AuthedRequest } from "../lib/auth";
import { deliverFile, deliveryTargets, isEmail, readUploadFile, type DeliveryVia } from "../services/documentDelivery";
import { documentChanged } from "../services/documentEvents";

const router: IRouter = Router();
router.use(authRequired);
const DOCS = requireAnyCap("editData", "legalization", "workerDocs");
const WD = requireCap("workerDocs");
const ok = (res: any, data: any) => res.json(data);
const fail = (res: any, code: number, msg: string) => res.status(code).json({ error: msg });

function parseVia(body: any): { via: DeliveryVia; email: string | null } | null {
  const via = body?.via;
  if (via !== "telegram" && via !== "email") return null;
  const email = typeof body?.email === "string" && body.email.trim() ? body.email.trim() : null;
  if (via === "email" && email && !isEmail(email)) return null;
  return { via, email };
}

router.get("/workers/:id/delivery-targets", DOCS, async (req, res) => {
  const t = await deliveryTargets(Number(req.params.id));
  if (!t) return fail(res, 404, "Працівника не знайдено");
  ok(res, t);
});

router.post("/worker-documents/:id/send", DOCS, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const p = parseVia(req.body);
  if (!p) return fail(res, 400, "via: telegram|email (email — коректна адреса)");
  const [doc] = await db.select().from(workerDocumentsTable).where(eq(workerDocumentsTable.id, id));
  if (!doc) return fail(res, 404, "Документ не знайдено");
  if (!doc.filePath) return fail(res, 400, "До документа не прикріплено файл");
  const buffer = readUploadFile(doc.filePath);
  if (!buffer) return fail(res, 404, "Файл не знайдено на диску");
  try {
    const { to } = await deliverFile({ workerId: doc.workerId, via: p.via, email: p.email, buffer, fileName: doc.fileName || `document-${id}`, title: doc.title });
    await documentChanged({ id, workerId: doc.workerId }, "sent", { adminId: req.admin?.adminId ?? null, name: req.admin?.name ?? null }, [{ field: "to", to }]);
    ok(res, { ok: true, to });
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося надіслати");
  }
});

router.post("/contracts/:id/files/:fileId/send", WD, async (req: AuthedRequest, res) => {
  const contractId = Number(req.params.id);
  const fileId = Number(req.params.fileId);
  const p = parseVia(req.body);
  if (!p) return fail(res, 400, "via: telegram|email (email — коректна адреса)");
  const [file] = await db.select().from(contractFilesTable).where(and(eq(contractFilesTable.id, fileId), eq(contractFilesTable.contractId, contractId)));
  if (!file) return fail(res, 404, "Файл не знайдено");
  const [contract] = await db.select({ workerId: contractsTable.workerId }).from(contractsTable).where(eq(contractsTable.id, contractId));
  if (!contract) return fail(res, 404, "Умову не знайдено");
  const relPath = file.signedPath ?? file.unsignedPath;
  const buffer = relPath ? readUploadFile(relPath) : null;
  if (!buffer) return fail(res, 404, "Файл ще не згенеровано");
  const fileName = `${file.title.replace(/[^\w.\- ]/g, "_")}.pdf`;
  try {
    const { to } = await deliverFile({ workerId: contract.workerId, via: p.via, email: p.email, buffer, fileName, title: file.title });
    await db.insert(signatureEventsTable).values({
      contractId, event: "file_sent", docSha256: file.signedSha256 ?? file.unsignedSha256 ?? null,
      extra: { fileId, via: p.via, to, adminId: req.admin?.adminId ?? null, signed: !!file.signedPath },
    });
    ok(res, { ok: true, to });
  } catch (e: any) {
    fail(res, 400, e?.message ?? "Не вдалося надіслати");
  }
});

export default router;
