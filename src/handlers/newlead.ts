import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { LeadRepository, now, type LeadIntent } from "../leads.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";

registerMainMenuItem({ label: "Submit a lead", data: "lead:new", order: 10 });

const composer = new Composer<Ctx>();

const forceReply = (placeholder: string) => ({
  reply_markup: { force_reply: true as const, input_field_placeholder: placeholder },
});

const intentKeyboard = inlineKeyboard([
  [inlineButton("Buy", "lead:intent:buy"), inlineButton("Rent", "lead:intent:rent"), inlineButton("Sell", "lead:intent:sell")],
  [inlineButton("Back to menu", "menu:main")],
]);

const confirmationKeyboard = inlineKeyboard([
  [inlineButton("Edit", "lead:edit"), inlineButton("Confirm", "lead:confirm")],
  [inlineButton("Back to menu", "menu:main")],
]);

function reset(ctx: Ctx): void {
  ctx.session.leadDraft = {};
  ctx.session.leadStep = "name";
  ctx.session.editingField = undefined;
  ctx.session.leadStartedAt = now().getTime();
}

function draftIsActive(ctx: Ctx): boolean {
  const started = ctx.session.leadStartedAt;
  if (started === undefined || now().getTime() - started <= 30 * 60 * 1000) return true;
  ctx.session.leadDraft = undefined;
  ctx.session.leadStep = undefined;
  ctx.session.editingField = undefined;
  ctx.session.leadStartedAt = undefined;
  return false;
}

async function requireActiveDraft(ctx: Ctx): Promise<boolean> {
  if (draftIsActive(ctx)) return true;
  await ctx.reply("This lead draft expired. Start a new one when you’re ready.");
  return false;
}

function phoneIsValid(value: string): boolean {
  return /^\+?[0-9][0-9()\-\s]{6,24}$/.test(value.trim());
}

function confirmationText(ctx: Ctx): string | undefined {
  const draft = ctx.session.leadDraft;
  if (!draft || !draft.name || !draft.phone || !draft.intent || !draft.note) return undefined;
  const complete = draft as Required<NonNullable<typeof draft>>;
  return `Please review your lead:\nName: ${complete.name}\nPhone: ${complete.phone}\nIntent: ${complete.intent}\nNote: ${complete.note}`;
}

async function askName(ctx: Ctx): Promise<void> {
  ctx.session.leadStep = "name";
  await ctx.reply("What is your name?", forceReply("Your full name"));
}

async function askPhone(ctx: Ctx): Promise<void> {
  ctx.session.leadStep = "phone";
  await ctx.reply("Share your phone number, or type it here.", forceReply("+1 555 123 4567"));
}

async function askNote(ctx: Ctx): Promise<void> {
  ctx.session.leadStep = "note";
  await ctx.reply("Tell us a little about what you need.", forceReply("Area, budget, timing, or other details"));
}

async function showConfirmation(ctx: Ctx, edit = false): Promise<void> {
  const text = confirmationText(ctx);
  if (!text) {
    await ctx.reply("Your lead is incomplete. Start again and fill in each detail.");
    return;
  }
  if (edit) await ctx.editMessageText(text, { reply_markup: confirmationKeyboard });
  else await ctx.reply(text, { reply_markup: confirmationKeyboard });
}

async function startLead(ctx: Ctx): Promise<void> {
  reset(ctx);
  await askName(ctx);
}

composer.command("newlead", startLead);
composer.callbackQuery("lead:new", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startLead(ctx);
});

composer.callbackQuery(/^lead:intent:(buy|rent|sell)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireActiveDraft(ctx))) return;
  if (ctx.session.leadStep !== "intent") {
    await ctx.reply("Start a new lead first, then choose the intent.");
    return;
  }
  ctx.session.leadDraft ??= {};
  ctx.session.leadDraft.intent = ctx.match[1] as LeadIntent;
  await askNote(ctx);
});

composer.callbackQuery("lead:edit", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireActiveDraft(ctx))) return;
  if (!confirmationText(ctx)) {
    await ctx.reply("That lead is no longer available. Start a new one.");
    return;
  }
  await ctx.editMessageText("Choose the detail to update.", {
    reply_markup: inlineKeyboard([
      [inlineButton("Name", "lead:field:name"), inlineButton("Phone", "lead:field:phone")],
      [inlineButton("Intent", "lead:field:intent"), inlineButton("Note", "lead:field:note")],
    ]),
  });
});

composer.callbackQuery(/^lead:field:(name|phone|intent|note)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireActiveDraft(ctx))) return;
  const field = ctx.match[1] as "name" | "phone" | "intent" | "note";
  if (!ctx.session.leadDraft) {
    await ctx.reply("That lead is no longer available. Start a new one.");
    return;
  }
  if (field === "intent") {
    ctx.session.leadStep = "intent";
    await ctx.editMessageText("Choose the intent.", { reply_markup: intentKeyboard });
    return;
  }
  ctx.session.editingField = field;
  ctx.session.leadStep = field;
  const prompts = { name: ["What is the updated name?", "Your full name"], phone: ["What is the updated phone number?", "+1 555 123 4567"], note: ["What is the updated note?", "Area, budget, timing, or other details"] } as const;
  await ctx.reply(prompts[field][0], forceReply(prompts[field][1]));
});

composer.callbackQuery("lead:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requireActiveDraft(ctx))) return;
  const draft = ctx.session.leadDraft;
  if (!draft?.name || !draft.phone || !draft.intent || !draft.note) {
    await ctx.reply("Your lead is incomplete. Start a new one and fill in each detail.");
    return;
  }
  const timestamp = now().toISOString();
  const lead = { id: crypto.randomUUID(), name: draft.name, phone: draft.phone, intent: draft.intent, note: draft.note, status: "new" as const, submittedAt: timestamp, statusUpdatedAt: timestamp };
  try {
    const saved = await new LeadRepository((ctx as Ctx & { env?: Record<string, unknown> }).env).create(lead);
    if (!saved) {
      await ctx.reply("Lead storage isn't set up yet. Please try again shortly.");
      return;
    }
  } catch {
    await ctx.reply("We couldn't save your lead. Please try again shortly.");
    return;
  }
  ctx.session.leadDraft = undefined;
  ctx.session.leadStep = undefined;
  ctx.session.editingField = undefined;
  ctx.session.leadStartedAt = undefined;
  await ctx.editMessageText("Your lead has been submitted. We’ll be in touch soon.");

  const owner = adminChatId(ctx as { env?: Record<string, unknown> });
  if (owner) {
    try {
      await ctx.api.sendMessage(owner, `New real estate lead\nName: ${lead.name}\nPhone: ${lead.phone}\nIntent: ${lead.intent}\nNote: ${lead.note}`);
    } catch {
      // A notification must not undo a saved lead when Telegram cannot deliver it.
    }
  }
});

composer.on("message:contact", async (ctx) => {
  if (ctx.session.leadStep !== "phone") return;
  if (!(await requireActiveDraft(ctx))) return;
  const contact = ctx.message.contact;
  if (contact.user_id !== undefined && contact.user_id !== ctx.from?.id) {
    await ctx.reply("Please share your own phone number, or type it instead.");
    return;
  }
  ctx.session.leadDraft ??= {};
  ctx.session.leadDraft.phone = contact.phone_number;
  ctx.session.editingField = undefined;
  ctx.session.leadStep = "intent";
  await ctx.reply("What would you like to do?", { reply_markup: intentKeyboard });
});

composer.on("message:text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  const step = ctx.session.leadStep;
  if (!step || text.startsWith("/")) return next();
  if (!(await requireActiveDraft(ctx))) return;
  ctx.session.leadDraft ??= {};
  if (step === "name") {
    if (text.length < 2 || text.length > 120) { await ctx.reply("Enter a name between 2 and 120 characters."); return; }
    ctx.session.leadDraft.name = text;
    ctx.session.editingField = undefined;
    await askPhone(ctx);
    return;
  }
  if (step === "phone") {
    if (!phoneIsValid(text)) { await ctx.reply("That phone number doesn’t look right. Include at least seven digits and try again."); return; }
    ctx.session.leadDraft.phone = text;
    ctx.session.editingField = undefined;
    ctx.session.leadStep = "intent";
    await ctx.reply("What would you like to do?", { reply_markup: intentKeyboard });
    return;
  }
  if (step === "note") {
    if (text.length < 2 || text.length > 1000) { await ctx.reply("Add a note between 2 and 1,000 characters."); return; }
    ctx.session.leadDraft.note = text;
    ctx.session.editingField = undefined;
    ctx.session.leadStep = undefined;
    await showConfirmation(ctx);
  }
});

export default composer;
