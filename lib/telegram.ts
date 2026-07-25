// Thin wrapper over the Telegram Bot HTTP API using fetch (no SDK dependency).
//
// Dev stub: when TELEGRAM_BOT_TOKEN is unset, outgoing calls are logged to the
// console and resolve with a fake message id instead of hitting the network.
// This lets the whole conversation flow be driven and observed via curl-ed
// webhook payloads with zero external dependency.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const API = `https://api.telegram.org/bot${TOKEN}`;

export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = InlineButton[][];

let stubMessageId = 1000;

async function call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T | null> {
  if (!TOKEN) {
    console.log(`[telegram:stub] ${method}`, JSON.stringify(payload));
    return { message_id: ++stubMessageId } as unknown as T;
  }
  try {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
        console.error(`[telegram] ${method} failed:`, data.description);
      return null;
    }
    return data.result as T;
  } catch (err) {
    console.error(`[telegram] ${method} error:`, err);
    return null;
  }
}

function replyMarkup(keyboard?: InlineKeyboard) {
  return keyboard && keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
}

export async function sendMessage(chatId: string | number, text: string, keyboard?: InlineKeyboard) {
  return call<{ message_id: number }>("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...replyMarkup(keyboard) });
}

export async function editMessageText(chatId: string | number, messageId: number, text: string, keyboard?: InlineKeyboard) {
  return call("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", ...replyMarkup(keyboard) });
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

export async function setWebhook(url: string, secretToken: string) {
  return call("setWebhook", { url, secret_token: secretToken, allowed_updates: ["message", "callback_query"] });
}

// Chunk a flat list of buttons into rows of `perRow`.
export function buttonRows(buttons: InlineButton[], perRow = 2): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}
