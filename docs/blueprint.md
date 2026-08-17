# Real Estate Lead Manager — Bot specification

**Archetype:** crm

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram bot for homebuyers/renters to submit real-estate leads with name, phone, intent (buy/rent/sell), and note. The bot confirms submissions and notifies the owner. The owner manages leads via a private admin view with status tracking (New/Done).

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Homebuyers
- Renters
- Real estate sellers
- Real estate agent (owner)

## Success criteria

- User submits lead with confirmation
- Owner receives notification for each new lead
- Owner can view and mark leads as New/Done

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu with /newlead option
- **/newlead** (command, actor: user, command: /newlead) — Start lead submission flow
- **Admin menu** (button, actor: owner, callback: admin:menu) — Private admin view for lead management

## Flows

### Lead submission
_Trigger:_ /newlead

1. Collect name via ForceReply
2. Collect phone via ForceReply or contact share
3. Select intent via buttons (Buy/Rent/Sell)
4. Collect note via ForceReply
5. Show confirmation with Edit/Confirm buttons

_Data touched:_ Lead

### Admin lead management
_Trigger:_ admin:menu

1. List leads with pagination (10 per page)
2. Show lead details with status toggle (New/Done)
3. Update lead status with audit timestamp

_Data touched:_ Lead

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — Telegram user ID to receive lead notifications and access admin view
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **Lead** _(retention: persistent)_ — Submitted lead with status tracking
  - fields: id, name, phone, intent, note, status, submitted_at
- **Owner/Admin** _(retention: persistent)_ — Single agent with private access
  - fields: telegram_chat_id

## Integrations

- **Telegram** (required) — Bot API messaging
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- View all leads
- Mark leads as New/Done
- Receive notifications for new leads

## Notifications

- Telegram message to owner when new lead is submitted

## Permissions & privacy

- Only owner can access admin menu and lead data
- User-submitted data is stored securely until manually deleted

## Edge cases

- Non-owner users attempting to access admin menu
- Incomplete lead submissions
- Invalid phone number formats

## Required tests

- End-to-end lead submission with confirmation flow
- Admin menu access control by chat ID
- Lead status toggling with audit timestamps

## Assumptions

- Single owner/admin model
- Leads are retained until manually marked Done
- No external API dependencies
