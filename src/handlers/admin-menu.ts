import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { LeadRepository, now, type Lead } from "../leads.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem, requireOwner } from "../toolkit/index.js";

registerMainMenuItem({ label: "Manage leads", data: "admin:menu", order: 20 });

const composer = new Composer<Ctx>();
const PER_PAGE = 10;

function env(ctx: Ctx): Record<string, unknown> | undefined {
  return (ctx as Ctx & { env?: Record<string, unknown> }).env;
}

function label(lead: Lead, number: number): string {
  return `${number}. ${lead.name} — ${lead.status === "done" ? "Done" : "New"}`;
}

function listKeyboard(leads: Lead[], page: number, total: number) {
  const rows = leads.map((lead, index) => [inlineButton(label(lead, page * PER_PAGE + index + 1), `admin:lead:${lead.id}`)]);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const controls = [];
  if (page > 0) controls.push(inlineButton("Previous", `admin:page:${page - 1}`));
  if (page < pages - 1) controls.push(inlineButton("Next", `admin:page:${page + 1}`));
  if (controls.length) rows.push(controls);
  rows.push([inlineButton("Back to menu", "menu:main")]);
  return inlineKeyboard(rows);
}

function detailText(lead: Lead): string {
  return `Lead details\nName: ${lead.name}\nPhone: ${lead.phone}\nIntent: ${lead.intent}\nNote: ${lead.note}\nStatus: ${lead.status === "done" ? "Done" : "New"}`;
}

function detailKeyboard(lead: Lead, page: number) {
  const action = lead.status === "done" ? "Mark as New" : "Mark as Done";
  const target = lead.status === "done" ? "new" : "done";
  return inlineKeyboard([
    [inlineButton(action, `admin:status:${lead.id}:${target}`)],
    [inlineButton("Back to leads", `admin:page:${page}`)],
  ]);
}

async function showPage(ctx: Ctx, page: number, edit: boolean): Promise<void> {
  const repository = new LeadRepository(env(ctx));
  const { leads, total } = await repository.page(page, PER_PAGE);
  const safePage = Math.min(Math.max(0, page), Math.max(0, Math.ceil(total / PER_PAGE) - 1));
  const text = total === 0 ? "No leads yet — new submissions will appear here." : `Your leads (${total})`;
  const markup = listKeyboard(leads, safePage, total);
  if (edit) await ctx.editMessageText(text, { reply_markup: markup });
  else await ctx.reply(text, { reply_markup: markup });
}

composer.callbackQuery("admin:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx as never))) return;
  try {
    await showPage(ctx, 0, false);
  } catch {
    await ctx.reply("Lead storage isn't available right now. Please try again shortly.");
  }
});

composer.callbackQuery(/^admin:page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx as never))) return;
  try {
    await showPage(ctx, Number(ctx.match[1]), true);
  } catch {
    await ctx.reply("Lead storage isn't available right now. Please try again shortly.");
  }
});

composer.callbackQuery(/^admin:lead:([0-9a-f-]{36})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx as never))) return;
  try {
    const lead = await new LeadRepository(env(ctx)).get(ctx.match[1]);
    if (!lead) { await ctx.reply("That lead is no longer available."); return; }
    await ctx.editMessageText(detailText(lead), { reply_markup: detailKeyboard(lead, 0) });
  } catch {
    await ctx.reply("Lead storage isn't available right now. Please try again shortly.");
  }
});

composer.callbackQuery(/^admin:status:([0-9a-f-]{36}):(new|done)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireOwner(ctx as never))) return;
  try {
    const lead = await new LeadRepository(env(ctx)).setStatus(ctx.match[1], ctx.match[2] as "new" | "done", now().toISOString());
    if (!lead) { await ctx.reply("That lead is no longer available."); return; }
    await ctx.editMessageText(detailText(lead), { reply_markup: detailKeyboard(lead, 0) });
  } catch {
    await ctx.reply("We couldn't update that lead. Please try again shortly.");
  }
});

export default composer;
