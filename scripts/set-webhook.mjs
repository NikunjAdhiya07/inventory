// Telegram webhook management for the Inventory Entry Bot (Story-3, Part B).
//
// Reads TELEGRAM_BOT_TOKEN (and optional TELEGRAM_WEBHOOK_SECRET) from .env.local.
//
// Usage (from inventory/):
//   node scripts/set-webhook.mjs info
//       → getMe + getWebhookInfo (read-only; shows the currently registered URL)
//   node scripts/set-webhook.mjs set https://<deployed-host>/api/telegram/webhook
//       → registers the webhook (secret_token from TELEGRAM_WEBHOOK_SECRET if set),
//         allowed_updates ["message","callback_query"], then prints getWebhookInfo
//   node scripts/set-webhook.mjs delete
//       → removes the webhook (bot stops receiving updates)
import { config } from "dotenv";

config({ path: ".env.local" });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set in .env.local. Aborting.");
  process.exit(2);
}

async function tg(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  return data;
}

function show(label, data) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const cmd = (process.argv[2] || "info").toLowerCase();

  if (cmd === "info") {
    show("getMe", await tg("getMe"));
    show("getWebhookInfo", await tg("getWebhookInfo"));
    return;
  }

  if (cmd === "set") {
    const url = process.argv[3];
    if (!url || !/^https:\/\//.test(url)) {
      console.error("Provide an https URL: node scripts/set-webhook.mjs set https://host/api/telegram/webhook");
      process.exit(2);
    }
    const payload = { url, allowed_updates: ["message", "callback_query"], drop_pending_updates: false };
    if (SECRET) payload.secret_token = SECRET;
    else console.warn("WARNING: TELEGRAM_WEBHOOK_SECRET is not set — the webhook route's secret check will be skipped.");
    show("setWebhook", await tg("setWebhook", payload));
    show("getWebhookInfo", await tg("getWebhookInfo"));
    return;
  }

  if (cmd === "delete") {
    show("deleteWebhook", await tg("deleteWebhook", { drop_pending_updates: false }));
    return;
  }

  if (cmd === "updates") {
    // Read-only peek at pending updates (does NOT confirm/drop them, so a later
    // setWebhook still delivers them). Only works while no webhook is set.
    const data = await tg("getUpdates", { timeout: 0 });
    show("getUpdates", data);
    if (data?.ok && Array.isArray(data.result)) {
      const seen = [];
      for (const u of data.result) {
        const m = u.message ?? u.callback_query?.message;
        const from = u.message?.from ?? u.callback_query?.from;
        if (from && m) seen.push({ fromId: from.id, name: from.username || from.first_name, chatId: m.chat?.id, chatType: m.chat?.type, chatTitle: m.chat?.title, text: u.message?.text });
      }
      show("parsed (fromId / chatId)", seen);
    }
    return;
  }

  console.error(`Unknown command '${cmd}'. Use: info | set <url> | delete`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
