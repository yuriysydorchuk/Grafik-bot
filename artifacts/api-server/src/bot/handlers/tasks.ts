// Модуль «Задачі» в боті офісу: інлайн-дії на сповіщеннях (беру в роботу / готово /
// завтра / буду / не зможу / моя частина / прийняти / повернути). Меню «📋 Задачі»
// й дайджести — services/taskDigest.ts (батч 3). Лише адміни (getAdmin).
import { type Telegraf } from "telegraf";
import { getAdmin } from "../roles";
import { loadTask, setTaskStatus, respondAssignee, snoozeTask, isParticipant, mdEsc } from "../../services/tasks";
import { hasCap } from "../../lib/roles";
import { loadRolesCache } from "../../lib/auth";

async function adminCanManage(admin: { role: string }): Promise<boolean> {
  const cache = await loadRolesCache();
  return hasCap(admin.role, cache.get(admin.role)?.caps ?? [], "tasksManage");
}

export function registerTaskActions(bot: Telegraf<any>) {
  bot.action(/^tsk:(start|done|snooze|yes|no|part|accept|return):(\d+)$/, async (ctx) => {
    const tid = String(ctx.from!.id);
    const admin = await getAdmin(tid);
    if (!admin) return ctx.answerCbQuery("Лише для офісу").catch(() => {});
    const action = (ctx.match as RegExpMatchArray)[1]!;
    const task = await loadTask(Number((ctx.match as RegExpMatchArray)[2]));
    if (!task) return ctx.answerCbQuery("Задачу не знайдено").catch(() => {});
    const participant = await isParticipant(task, admin.id);
    const manage = await adminCanManage(admin);
    let stamp = "";
    try {
      if (action === "start") { if (!participant && !manage) throw new Error("не ваша задача"); await setTaskStatus(task, "in_progress", admin.id); stamp = "▶ у роботі"; }
      else if (action === "done") { if (!participant && !manage) throw new Error("не ваша задача"); const u = await setTaskStatus(task, "done", admin.id); stamp = u.status === "review" ? "🔎 на перевірці в автора" : "✅ виконано"; }
      else if (action === "snooze") { if (!participant && !manage) throw new Error("не ваша задача"); await snoozeTask(task, 1, admin.id); stamp = "⏰ нагадаю завтра"; }
      else if (action === "yes" || action === "no") { if (!participant) throw new Error("ви не учасник"); await respondAssignee(task, admin.id, action === "yes" ? "accepted" : "declined"); stamp = action === "yes" ? "✅ буду" : "❌ не зможу"; }
      else if (action === "part") { if (!participant) throw new Error("ви не учасник"); await respondAssignee(task, admin.id, "done"); stamp = "✅ моя частина готова"; }
      else if (action === "accept" || action === "return") {
        if (task.creatorAdminId !== admin.id && !manage) throw new Error("лише автор");
        if (task.status !== "review") throw new Error("задача не на перевірці");
        await setTaskStatus(task, action === "accept" ? "done" : "in_progress", admin.id, action === "return" ? "повернуто з бота" : null);
        stamp = action === "accept" ? "✅ прийнято" : "↩️ повернуто виконавцю";
      }
    } catch (e: any) { return ctx.answerCbQuery(`⛔ ${e?.message ?? "помилка"}`).catch(() => {}); }
    await ctx.answerCbQuery(stamp).catch(() => {});
    // штамп на повідомленні + зняти кнопки (як у авансів/пропусків)
    const old = (ctx.callbackQuery as any)?.message?.text as string | undefined;
    if (old) await ctx.editMessageText(`${old}\n\n— ${stamp} · ${mdEsc(admin.name ?? "")}`).catch(() => {});
  });
}
