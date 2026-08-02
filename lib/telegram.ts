// Thin wrapper over the Telegram Bot HTTP API using fetch (no SDK dependency).
//
// Dev stub: when TELEGRAM_BOT_TOKEN is unset, outgoing calls are logged to the
// console and resolve with a fake message id instead of hitting the network.
// This lets the whole conversation flow be driven and observed via curl-ed
// webhook payloads with zero external dependency.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = `https://api.telegram.org/bot${TOKEN}`;
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS) || 6000;

export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = InlineButton[][];

let stubMessageId = 1000;

type CallResult<T> = { ok: true; result: T } | { ok: false; description: string };

async function callRaw<T = unknown>(method: string, payload: Record<string, unknown>): Promise<CallResult<T>> {
  if (!TOKEN) {
    console.log(`[telegram:stub] ${method}`, JSON.stringify(payload));
    return { ok: true, result: { message_id: ++stubMessageId } as unknown as T };
  }
  try {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Without a timeout a stalled Telegram connection holds the whole function
      // until the platform kills it, and the user sees nothing at all. Failing at
      // 6s lets `render` fall back to a fresh send instead.
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    const data = await res.json();
    if (!data.ok) {
      const description = String(data.description ?? "unknown error");
      // "message is not modified" is a no-op, not a failure: the anchor already
      // shows exactly what we were about to draw, which is what a double-tap
      // looks like. `editMessageText` reports it as `notModified` and `render`
      // treats it as a successful redraw, so logging it at error level only
      // sent people chasing an incident that never happened.
      if (!/message is not modified/i.test(description)) {
        console.error(`[telegram] ${method} failed:`, description);
      }
      return { ok: false, description };
    }
    return { ok: true, result: data.result as T };
  } catch (err) {
    console.error(`[telegram] ${method} error:`, err);
    return { ok: false, description: String(err) };
  }
}

async function call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T | null> {
  const res = await callRaw<T>(method, payload);
  return res.ok ? res.result : null;
}

function replyMarkup(keyboard?: InlineKeyboard) {
  return keyboard && keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
}

export async function sendMessage(chatId: string | number, text: string, keyboard?: InlineKeyboard) {
  return call<{ message_id: number }>("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...replyMarkup(keyboard) });
}

// Outcome of an in-place edit. `notModified` means Telegram rejected the edit
// because the text and keyboard are already exactly what's on screen — nothing
// is wrong, so callers must not fall back to sending a duplicate message.
export type EditResult = { ok: boolean; notModified: boolean };

export async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<EditResult> {
  // Always send reply_markup explicitly: an empty inline_keyboard is what clears
  // the buttons off a finished/cancelled entry.
  const res = await callRaw("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard ?? [] },
  });
  if (res.ok) return { ok: true, notModified: false };
  return { ok: false, notModified: /message is not modified/i.test(res.description) };
}

export async function editMessageReplyMarkup(chatId: string | number, messageId: number, keyboard?: InlineKeyboard) {
  return call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, ...replyMarkup(keyboard) });
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  return call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

export async function getFile(fileId: string) {
  return call<{ file_path: string }>("getFile", { file_id: fileId });
}

// Download Telegram file bytes for vision / storage. Returns null when the bot
// token is missing (dev stub) or Telegram refuses the file.
export async function downloadFileBytes(
  fileId: string
): Promise<{ bytes: Buffer; mime: string; filePath: string } | null> {
  if (!TOKEN) {
    console.log("[telegram:stub] downloadFileBytes", fileId);
    return null;
  }
  const meta = await getFile(fileId);
  if (!meta?.file_path) return null;
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${meta.file_path}`, {
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS * 3),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const lower = meta.file_path.toLowerCase();
    const mime = lower.endsWith(".png")
      ? "image/png"
      : lower.endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
    return { bytes: buf, mime, filePath: meta.file_path };
  } catch (err) {
    console.error("[telegram] downloadFileBytes error:", err);
    return null;
  }
}

// Health probe: getChat succeeds only when the bot is a member of the chat and
// the Telegram API is reachable, so a non-null result means the bot is live in
// that group. In the dev stub (no token) this resolves truthy → "healthy".
export async function getChat(chatId: string | number) {
  return call<{ id: number; title?: string; type?: string }>("getChat", { chat_id: chatId });
}

export async function setWebhook(url: string, secretToken: string) {
  return call("setWebhook", { url, secret_token: secretToken, allowed_updates: ["message", "callback_query"] });
}

// Chunk a flat list of buttons into rows of `perRow`.
export function buttonRows(buttons: InlineButton[], perRow = 2): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}
