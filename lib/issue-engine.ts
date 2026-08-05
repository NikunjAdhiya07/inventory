import type { Db } from "mongodb";
import { searchStock, type StockHit } from "./stock";
import { buttonRows, type InlineKeyboard } from "./telegram";
import { approversFor, issuablePeople, mentionList, type Person } from "./issues";
import {
  MAX_LINES,
  STORE_ROLE,
  USER_PAGE_SIZE,
  type MaterialLine,
  type MaterialTicket,
} from "./issue-types";

// The issue/return conversation.
//
// Same anchor-message design as the other two flows: ONE message per ticket,
// edited in place from the first search to the moment it settles. That matters
// more here than anywhere else, because this flow shares its group with the
// entry workflow — a handover that sprayed a message per step would bury the
// entries people are also logging in the same chat.
//
// Like the request bot and unlike the entry bot, there is no linear step cursor.
// Which screen you see is derived from the ticket's kind, its status and a small
// `ui` scratch object — so a store head opening a four-day-old ticket and a
// recipient half-way through a return both render correctly from the document
// alone, with no session that has to still be alive.

export type RenderResult = { text: string; keyboard: InlineKeyboard };

export type EngineResult = {
  render?: RenderResult;
  notice?: string;
};

const PAGE_SIZE = 6;
const LOCATIONS_SHOWN = 6;

// Free text — a product name, a location, whatever the store head typed — lands
// inside an HTML-parsed message. Telegram rejects the whole send when the markup
// does not parse, so an item legitimately called `<3 cable` would take the bot
// down for that ticket rather than just looking odd.
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function renderTicket(db: Db, ticket: MaterialTicket): Promise<RenderResult> {
  if (ticket.kind === "return") return renderReturn(db, ticket);
  return renderIssue(db, ticket);
}

async function renderIssue(db: Db, ticket: MaterialTicket): Promise<RenderResult> {
  switch (ticket.status) {
    case "draft":
      return renderIssueDraft(db, ticket);
    case "awaiting_ack":
      return renderAwaitingAck(ticket);
    case "acknowledged":
      return renderAcknowledged(ticket);
    case "disputed":
      return renderDisputed(db, ticket);
    default:
      return { text: closedIssueText(ticket), keyboard: [] };
  }
}

async function renderReturn(db: Db, ticket: MaterialTicket): Promise<RenderResult> {
  switch (ticket.status) {
    case "draft":
      return renderReturnDraft(ticket);
    case "pending_store":
      return renderPendingStore(db, ticket);
    default:
      return { text: closedReturnText(ticket), keyboard: [] };
  }
}

// ---------------------------------------------------------------------------
// Issue: building the ticket
// ---------------------------------------------------------------------------

async function renderIssueDraft(db: Db, ticket: MaterialTicket): Promise<RenderResult> {
  const ui = ticket.ui;
  if (ui.stage === "who") return renderWhoPicker(db, ticket);
  if (ui.focusProductId && ui.focusLocationId) return renderQtyPad(db, ticket);
  if (ui.focusProductId) return renderProductDetail(db, ticket);
  if (ui.query) return renderResults(db, ticket);
  return renderCart(ticket);
}

async function renderResults(db: Db, ticket: MaterialTicket): Promise<RenderResult> {
  const ui = ticket.ui;
  const hits = await searchStock(db, ui.query);

  if (!hits.length) {
    return {
      text: `No stock for “${esc(ui.query)}”. Try another name or a reference tag (e.g. “c type cable”).`,
      keyboard: [cartRow(ticket), [{ text: "✖ Cancel", callback_data: "is:cancel" }]],
    };
  }

  const pageCount = Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
  // Clamp rather than trust: a narrower search can leave the cursor past the end.
  const page = Math.min(Math.max(ui.page ?? 0, 0), pageCount - 1);
  ui.page = page;
  const start = page * PAGE_SIZE;
  const slice = hits.slice(start, start + PAGE_SIZE);

  const lines = [`<b>${hits.length}</b> match${hits.length === 1 ? "" : "es"} for “${esc(ui.query)}”`, ""];
  for (const [i, hit] of slice.entries()) {
    lines.push(`<b>${start + i + 1}. ${esc(hit.name)}</b> — ${money(hit.total)} ${esc(hit.unit)}`);
  }

  // The callback carries the index into the FULL result list, so paging can never
  // shift what a button means.
  const btns = slice.map((hit, i) => ({
    text: `${start + i + 1}. ${truncate(hit.name, 28)}`,
    callback_data: `is:s:${start + i}`,
  }));
  const rows: InlineKeyboard = buttonRows(btns, 2);

  const pager = [];
  if (page > 0) pager.push({ text: "◀ Prev", callback_data: "is:pg:p" });
  if (page < pageCount - 1) pager.push({ text: "Next ▶", callback_data: "is:pg:n" });
  if (pager.length) rows.push(pager);
  rows.push(cartRow(ticket));

  return { text: lines.join("\n"), keyboard: rows };
}

async function renderProductDetail(db: Db, ticket: MaterialTicket): Promise<RenderResult> {
  const hit = await focusedHit(db, ticket);
  if (!hit) {
    return { text: "That material is no longer in stock. Search again.", keyboard: [cartRow(ticket)] };
  }

  const lines = [`<b>${esc(hit.name)}</b> — ${money(hit.total)} ${esc(hit.unit)}`, "", "<i>Take it from where?</i>", ""];
  for (const l of hit.lines.slice(0, LOCATIONS_SHOWN)) {
    lines.push(`📍 ${esc(l.locationPath)} — <b>${money(l.qty)}</b>`);
  }

  const btns = hit.lines.slice(0, LOCATIONS_SHOWN).map((l, i) => ({
    text: `📍 ${truncate(l.locationPath, 28)} (${money(l.qty)})`,
    callback_data: `is:l:${i}`,
  }));

  return {
    text: lines.join("\n"),
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "is:back" }], cartRow(ticket)],
  };
}

// A keypad rather than a typed number, for the same reason the other two bots
// use one: a typed quantity is a second chat message, which is precisely what
// the single-anchor design exists to avoid.
async function renderQtyPad(db: Db, ticket: MaterialTicket): Promise<RenderResult> {
  const hit = await focusedHit(db, ticket);
  const line = hit?.lines.find((l) => l.locationId === ticket.ui.focusLocationId);
  if (!hit || !line) {
    return { text: "That location no longer holds this material. Search again.", keyboard: [cartRow(ticket)] };
  }

  const draft = ticket.ui.qtyDraft ?? "";
  const text =
    `<b>${esc(hit.name)}</b>\n` +
    `${esc(line.locationPath)} · ${money(line.qty)} ${esc(line.unit)} on hand\n\n` +
    `Issuing: <b>${draft || "—"}</b>`;

  return { text, keyboard: keypad("is:q", "✔ Add", [[{ text: "⬅ Back", callback_data: "is:back" }], cartRow(ticket)]) };
}

function renderCart(ticket: MaterialTicket): RenderResult {
  const who = ticket.recipient;

  if (!ticket.lines.length) {
    return {
      text:
        `📤 <b>Issue materials</b>\n\n` +
        `Type what is going out — a product name or a reference tag.\n` +
        `<i>While this is open your messages fill this ticket. Send /cancel to close it and go back to normal.</i>\n\n` +
        `<b>Issuing to:</b> ${who ? esc(who.name) : "<i>not chosen yet</i>"}`,
      keyboard: [
        [{ text: who ? `👤 ${truncate(who.name, 24)}` : "👤 Choose who", callback_data: "is:who" }],
        [{ text: "✖ Cancel", callback_data: "is:cancel" }],
      ],
    };
  }

  const lines = [`📤 <b>Issue materials</b>`, "", ...cartLines(ticket.lines), ""];
  lines.push(`<b>Issuing to:</b> ${who ? esc(who.name) : "⚠️ <i>not chosen yet</i>"}`);
  if (!who) lines.push("", "<i>Choose who is taking these before you can issue them.</i>");

  const removes = ticket.lines.map((l, i) => ({
    text: `✖ ${i + 1}. ${truncate(l.productName, 22)}`,
    callback_data: `is:rm:${l.lineId}`,
  }));

  return {
    text: lines.join("\n"),
    keyboard: [
      ...buttonRows(removes, 2),
      [{ text: who ? `👤 ${truncate(who.name, 24)}` : "👤 Choose who", callback_data: "is:who" }],
      [{ text: "✅ Issue", callback_data: "is:sub" }],
      [{ text: "✖ Cancel", callback_data: "is:cancel" }],
    ],
  };
}

function cartLines(lines: MaterialLine[]): string[] {
  return lines.map((l, i) => {
    const head = `<b>${i + 1}. ${esc(l.productName)}</b> × ${money(l.qty)} ${esc(l.unit)}`;
    const mark = l.outcome === "unavailable" ? "  ⚠️ <i>out of stock</i>" : l.outcome === "issued" ? "  ✅" : "";
    return `${head}\n   📍 ${esc(l.locationPath)}${mark}`;
  });
}

// ---------------------------------------------------------------------------
// Issue: who is taking the materials
// ---------------------------------------------------------------------------

async function renderWhoPicker(db: Db, ticket: MaterialTicket): Promise<RenderResult> {
  const people = await matchingPeople(db, ticket);
  const ui = ticket.ui;

  if (!people.length) {
    const why = ui.whoQuery
      ? `Nobody matches “${esc(ui.whoQuery)}”. Type a different name.`
      : "Nobody in this workspace can be issued materials yet — they need an active account with a Telegram id.";
    return { text: `👤 <b>Issue to whom?</b>\n\n${why}`, keyboard: [[{ text: "⬅ Back", callback_data: "is:back" }]] };
  }

  const pageCount = Math.max(1, Math.ceil(people.length / USER_PAGE_SIZE));
  const page = Math.min(Math.max(ui.whoPage ?? 0, 0), pageCount - 1);
  ui.whoPage = page;
  const start = page * USER_PAGE_SIZE;
  const slice = people.slice(start, start + USER_PAGE_SIZE);

  const header = [
    `👤 <b>Issue to whom?</b>`,
    ui.whoQuery ? `<i>Matching “${esc(ui.whoQuery)}”</i>` : "<i>Type a name to narrow the list.</i>",
    "",
  ];

  // Index into the FULL filtered list, so paging cannot shift what a button means.
  const btns = slice.map((p, i) => ({
    text: truncate(p.name || p.handle || p.tgId, 26),
    callback_data: `is:u:${start + i}`,
  }));
  const rows: InlineKeyboard = buttonRows(btns, 2);

  const pager = [];
  if (page > 0) pager.push({ text: "◀ Prev", callback_data: "is:upg:p" });
  if (page < pageCount - 1) pager.push({ text: "Next ▶", callback_data: "is:upg:n" });
  if (pager.length) rows.push(pager);
  rows.push([{ text: "⬅ Back", callback_data: "is:back" }]);

  return { text: header.join("\n"), keyboard: rows };
}

// The candidate list the picker is currently showing. Recomputed rather than
// remembered so a tap always resolves against the same list the tapper saw, even
// if the roster changed between the render and the tap.
export async function matchingPeople(db: Db, ticket: MaterialTicket): Promise<Person[]> {
  const all = await issuablePeople(db);
  const q = (ticket.ui.whoQuery ?? "").trim().toLowerCase();
  // The author is filtered out: a store head issuing materials to themselves has
  // nobody left to acknowledge the handover, which is the whole point of the
  // acknowledgement step.
  const others = all.filter((p) => p.tgId !== ticket.createdByUserId);
  if (!q) return others;
  return others.filter((p) => `${p.name} ${p.handle} ${p.role}`.toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// Issue: after submission
// ---------------------------------------------------------------------------

function issueHeader(ticket: MaterialTicket, title: string): string[] {
  return [
    `🎫 <b>${esc(ticket.ticketNumber ?? "")}</b> — ${title}`,
    `Issued by <b>${esc(ticket.createdByName)}</b> to <b>${esc(ticket.recipient?.name ?? "—")}</b>`,
    "",
  ];
}

function issuedLines(ticket: MaterialTicket): string[] {
  const issued = ticket.lines.filter((l) => l.outcome === "issued");
  const short = ticket.lines.filter((l) => l.outcome === "unavailable");
  const out = cartLines(issued.length ? issued : ticket.lines);
  if (short.length) out.push("", `⚠️ <i>${short.length} line(s) were out of stock and were not issued.</i>`);
  return out;
}

function renderAwaitingAck(ticket: MaterialTicket): RenderResult {
  const who = ticket.recipient;
  const lines = issueHeader(ticket, "waiting to be acknowledged");
  lines.push(...issuedLines(ticket));
  lines.push("", `${esc(who?.handle || who?.name || "")} — confirm you have received these.`);

  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: "✔ Acknowledge", callback_data: "is:ack" },
        { text: "✖ Not received", callback_data: "is:nack" },
      ],
      [{ text: "🗑 Cancel & restock", callback_data: "is:cancel" }],
    ],
  };
}

function renderAcknowledged(ticket: MaterialTicket): RenderResult {
  const who = ticket.recipient;
  const lines = issueHeader(ticket, "acknowledged — materials are out");
  lines.push(...issuedLines(ticket));
  lines.push("", ...historyLines(ticket));
  lines.push(
    "",
    `<i>When the job is done, ${esc(who?.name ?? "the recipient")} raises a return for whatever is left over. ` +
      `Anything not returned counts as consumed.</i>`
  );

  return {
    text: lines.join("\n"),
    keyboard: [
      [{ text: "↩️ Return unused", callback_data: "is:ret" }],
      [{ text: "🗑 Cancel & restock", callback_data: "is:cancel" }],
    ],
  };
}

async function renderDisputed(db: Db, ticket: MaterialTicket): Promise<RenderResult> {
  const store = await approversFor(db, STORE_ROLE);
  const lines = issueHeader(ticket, "⚠️ disputed — not received");
  lines.push(...issuedLines(ticket));
  lines.push("", ...historyLines(ticket));
  lines.push("", tagLine(store, STORE_ROLE, "please check what happened to these"));

  return {
    text: lines.join("\n"),
    keyboard: [
      [{ text: "✔ Acknowledge after all", callback_data: "is:ack" }],
      [{ text: "🗑 Cancel & restock", callback_data: "is:cancel" }],
    ],
  };
}

function closedIssueText(ticket: MaterialTicket): string {
  const titles: Record<string, string> = {
    settled: "✅ settled",
    cancelled: "🚫 cancelled — materials back in stock",
  };
  const lines = issueHeader(ticket, titles[ticket.status] ?? ticket.status);

  if (ticket.status === "settled") {
    // The settlement breakdown IS the point of the whole flow, so it is spelled
    // out per line rather than left as a total the store has to reconstruct.
    for (const [i, l] of ticket.lines.filter((x) => x.outcome === "issued").entries()) {
      lines.push(
        `<b>${i + 1}. ${esc(l.productName)}</b> — issued ${money(l.qty)} ${esc(l.unit)}`,
        `   ↩️ returned <b>${money(l.returnedQty ?? 0)}</b> · 🔨 consumed <b>${money(l.consumedQty ?? 0)}</b>`
      );
    }
  } else {
    lines.push(...issuedLines(ticket));
  }

  lines.push("", ...historyLines(ticket));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Return tickets
// ---------------------------------------------------------------------------

function returnHeader(ticket: MaterialTicket, title: string): string[] {
  return [
    `↩️ <b>${esc(ticket.ticketNumber ?? "Return")}</b> — ${title}`,
    `Against <b>${esc(ticket.issueTicketNumber ?? "")}</b> · from <b>${esc(ticket.createdByName)}</b>`,
    "",
  ];
}

// Every issued line, with what is going back and what that leaves as consumed.
// Both numbers are shown on every line, including the untouched ones, because
// "0 returned / 5 consumed" is a statement the recipient is signing for — not a
// gap in the form.
function returnLines(ticket: MaterialTicket): string[] {
  return ticket.lines.map((l, i) => {
    const issued = l.issuedQty ?? 0;
    const consumed = issued - l.qty;
    return (
      `<b>${i + 1}. ${esc(l.productName)}</b> — took ${money(issued)} ${esc(l.unit)}\n` +
      `   ↩️ returning <b>${money(l.qty)}</b> · 🔨 consumed <b>${money(consumed)}</b>`
    );
  });
}

function renderReturnDraft(ticket: MaterialTicket): RenderResult {
  const focus = ticket.ui.focusReturnLineId
    ? ticket.lines.find((l) => l.lineId === ticket.ui.focusReturnLineId)
    : null;

  if (focus) {
    const issued = focus.issuedQty ?? 0;
    const draft = ticket.ui.qtyDraft ?? "";
    const text =
      `<b>${esc(focus.productName)}</b>\n` +
      `Took ${money(issued)} ${esc(focus.unit)} · back to ${esc(focus.locationPath)}\n` +
      `<i>Currently returning ${money(focus.qty)}.</i>\n\n` +
      `Returning: <b>${draft || "0"}</b>\n` +
      `<i>Whatever you do not return counts as consumed on the job.</i>`;
    return {
      text,
      keyboard: keypad("is:rq", "✔ Set", [[{ text: "⬅ Back", callback_data: "is:back" }]]),
    };
  }

  const total = ticket.lines.reduce((s, l) => s + l.qty, 0);
  const lines = [
    `↩️ <b>Returning materials</b>`,
    `Against <b>${esc(ticket.issueTicketNumber ?? "")}</b>`,
    "",
    ...returnLines(ticket),
    "",
    "<i>Tap a line to say how much is coming back.</i>",
  ];

  const picks = ticket.lines.map((l, i) => ({
    text: `${i + 1}. ${truncate(l.productName, 20)} (${money(l.qty)})`,
    callback_data: `is:rl:${l.lineId}`,
  }));

  return {
    text: lines.join("\n"),
    keyboard: [
      ...buttonRows(picks, 2),
      [{ text: total > 0 ? "✅ Submit return" : "✅ Nothing left — all consumed", callback_data: "is:rsub" }],
      [{ text: "✖ Cancel", callback_data: "is:cancel" }],
    ],
  };
}

async function renderPendingStore(db: Db, ticket: MaterialTicket): Promise<RenderResult> {
  const store = await approversFor(db, STORE_ROLE);
  const lines = returnHeader(ticket, "waiting for the store to confirm");
  lines.push(...returnLines(ticket));
  lines.push("", tagLine(store, STORE_ROLE, "confirm you have these back"));

  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: "✔ Accept return", callback_data: "is:racc" },
        { text: "✖ Reject", callback_data: "is:rrej" },
      ],
      [{ text: "🗑 Withdraw", callback_data: "is:cancel" }],
    ],
  };
}

function closedReturnText(ticket: MaterialTicket): string {
  const titles: Record<string, string> = {
    accepted: "✅ accepted — back in stock",
    rejected: "⛔ rejected",
    cancelled: "🚫 withdrawn",
  };
  const lines = returnHeader(ticket, titles[ticket.status] ?? ticket.status);
  lines.push(...returnLines(ticket));
  lines.push("", ...historyLines(ticket));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function keypad(prefix: string, confirm: string, tail: InlineKeyboard): InlineKeyboard {
  const key = (d: string) => ({ text: d, callback_data: `${prefix}:${d}` });
  return [
    ["1", "2", "3"].map(key),
    ["4", "5", "6"].map(key),
    ["7", "8", "9"].map(key),
    [key("."), key("0"), { text: "⌫", callback_data: `${prefix}:del` }],
    [{ text: confirm, callback_data: `${prefix}:ok` }],
    ...tail,
  ];
}

function cartRow(ticket: MaterialTicket): InlineKeyboard[number] {
  const row = [];
  if (ticket.lines.length) row.push({ text: `🧺 Cart (${ticket.lines.length})`, callback_data: "is:cart" });
  row.push({ text: "✖ Cancel", callback_data: "is:cancel" });
  return row;
}

function historyLines(ticket: MaterialTicket): string[] {
  return ticket.history.slice(-5).map((h) => `• ${esc(h.by)} — ${esc(h.what)}`);
}

function tagLine(people: { name: string; handle: string }[], role: string, ask: string): string {
  const mentions = mentionList(people.map((p) => ({ ...p, tgId: "" })));
  if (!mentions) {
    return `⚠️ <i>Nobody holds the ${esc(role)} role yet — an admin has to assign it before this can be actioned.</i>`;
  }
  return `${mentions} — ${esc(ask)}. <i>(${esc(role)})</i>`;
}

// The product currently open, re-resolved from the live search rather than
// remembered. Stock changes between taps, and rendering a remembered snapshot
// would offer quantities that no longer exist.
async function focusedHit(db: Db, ticket: MaterialTicket): Promise<StockHit | null> {
  const hits = await searchStock(db, ticket.ui.query);
  return hits.find((h) => h.productId === ticket.ui.focusProductId) ?? null;
}

// ---------------------------------------------------------------------------
// Typed input
// ---------------------------------------------------------------------------

export async function applyMessage(db: Db, ticket: MaterialTicket, text: string): Promise<EngineResult> {
  const trimmed = text.trim();
  if (!trimmed) return { render: await renderTicket(db, ticket) };

  // Only a draft accepts typing. A submitted ticket is driven by its buttons, so
  // ordinary chatter in the group must not disturb it.
  if (ticket.status !== "draft") return {};

  // A return draft has a fixed set of lines and no search — everything on it is
  // driven by the keypad, so typed text has nothing to act on.
  if (ticket.kind === "return") return { notice: "Tap a line to set how much is coming back." };

  if (ticket.ui.stage === "who") {
    ticket.ui.whoQuery = trimmed.slice(0, 40);
    ticket.ui.whoPage = 0;
    return { render: await renderTicket(db, ticket) };
  }

  ticket.ui.query = trimmed.slice(0, 60);
  ticket.ui.page = 0;
  ticket.ui.focusProductId = null;
  ticket.ui.focusLocationId = null;
  ticket.ui.qtyDraft = "";
  return { render: await renderTicket(db, ticket) };
}

// ---------------------------------------------------------------------------
// Draft callbacks
// ---------------------------------------------------------------------------

// Handles only the draft-stage taps — building a cart, choosing a recipient,
// setting return quantities. Status transitions live in the webhook so that the
// permission check sits next to the transition it guards.
export async function applyDraftCallback(db: Db, ticket: MaterialTicket, data: string): Promise<EngineResult> {
  const ui = ticket.ui;

  if (data === "is:cart") {
    ui.stage = "search";
    ui.query = "";
    ui.focusProductId = null;
    ui.focusLocationId = null;
    return { render: await renderTicket(db, ticket) };
  }

  if (data === "is:back") {
    // One step back out of whatever is open, innermost first.
    if (ui.stage === "who") {
      ui.stage = "search";
      ui.whoQuery = "";
      ui.whoPage = 0;
    } else if (ui.focusReturnLineId) {
      ui.focusReturnLineId = null;
    } else if (ui.focusLocationId) {
      ui.focusLocationId = null;
    } else if (ui.focusProductId) {
      ui.focusProductId = null;
    } else {
      ui.query = "";
    }
    ui.qtyDraft = "";
    return { render: await renderTicket(db, ticket) };
  }

  if (data === "is:who") {
    ui.stage = "who";
    ui.whoQuery = "";
    ui.whoPage = 0;
    return { render: await renderTicket(db, ticket) };
  }

  if (data.startsWith("is:upg:")) {
    ui.whoPage = Math.max(0, (ui.whoPage ?? 0) + (data === "is:upg:n" ? 1 : -1));
    return { render: await renderTicket(db, ticket) };
  }

  if (data.startsWith("is:u:")) {
    const people = await matchingPeople(db, ticket);
    const person = people[Number(data.slice("is:u:".length))];
    if (!person) return { notice: "That person is no longer available." };
    ticket.recipient = { userId: person.tgId, dbId: person.dbId, name: person.name, handle: person.handle };
    ui.stage = "search";
    ui.whoQuery = "";
    ui.whoPage = 0;
    return { render: await renderTicket(db, ticket) };
  }

  if (data.startsWith("is:pg:")) {
    ui.page = Math.max(0, (ui.page ?? 0) + (data === "is:pg:n" ? 1 : -1));
    return { render: await renderTicket(db, ticket) };
  }

  if (data.startsWith("is:s:")) {
    const hits = await searchStock(db, ui.query);
    const hit = hits[Number(data.slice("is:s:".length))];
    if (!hit) return { notice: "That material is no longer available." };
    ui.focusProductId = hit.productId;
    ui.focusLocationId = null;
    ui.qtyDraft = "";
    return { render: await renderTicket(db, ticket) };
  }

  if (data.startsWith("is:l:")) {
    const hit = await focusedHit(db, ticket);
    const line = hit?.lines[Number(data.slice("is:l:".length))];
    if (!line) return { notice: "That location is no longer available." };
    ui.focusLocationId = line.locationId;
    ui.qtyDraft = "";
    return { render: await renderTicket(db, ticket) };
  }

  if (data.startsWith("is:q:")) return applyIssueQty(db, ticket, data.slice("is:q:".length));

  if (data.startsWith("is:rm:")) {
    const lineId = data.slice("is:rm:".length);
    const before = ticket.lines.length;
    ticket.lines = ticket.lines.filter((l) => l.lineId !== lineId);
    if (ticket.lines.length === before) return { notice: "That material is already off the ticket." };
    return { render: await renderTicket(db, ticket) };
  }

  if (data.startsWith("is:rl:")) {
    const lineId = data.slice("is:rl:".length);
    const line = ticket.lines.find((l) => l.lineId === lineId);
    if (!line) return { notice: "That line is not on this return." };
    ui.focusReturnLineId = lineId;
    // Deliberately NOT pre-filled with what the line already says. Seeding the
    // keypad with "2" and then having the next digit append to it — so tapping
    // 3 to correct a 2 produces 23 — is worse than retyping two characters, and
    // it makes this keypad behave differently from the issue-side one for no
    // reason. The current value is shown in the text instead.
    ui.qtyDraft = "";
    return { render: await renderTicket(db, ticket) };
  }

  if (data.startsWith("is:rq:")) return applyReturnQty(db, ticket, data.slice("is:rq:".length));

  return { notice: "Use the buttons above." };
}

// ---------------------------------------------------------------------------
// Keypads
// ---------------------------------------------------------------------------

// Apply one keypress to a draft quantity. Shared by both keypads: they differ
// only in what Confirm commits to.
function press(draft: string, key: string): { draft: string } | { notice: string } {
  if (key === "del") return { draft: draft.slice(0, -1) };
  if (key === ".") {
    if (draft.includes(".")) return { notice: "Only one decimal point." };
    return { draft: draft === "" ? "0." : `${draft}.` };
  }
  if (draft.replace(".", "").length >= 9) return { notice: "That's as large as a quantity can get." };
  return { draft: draft === "0" ? key : draft + key };
}

async function applyIssueQty(db: Db, ticket: MaterialTicket, key: string): Promise<EngineResult> {
  if (key === "ok") return commitIssueLine(db, ticket, ticket.ui.qtyDraft ?? "");
  const res = press(ticket.ui.qtyDraft ?? "", key);
  if ("notice" in res) return res;
  ticket.ui.qtyDraft = res.draft;
  return { render: await renderTicket(db, ticket) };
}

async function applyReturnQty(db: Db, ticket: MaterialTicket, key: string): Promise<EngineResult> {
  if (key === "ok") {
    const line = ticket.lines.find((l) => l.lineId === ticket.ui.focusReturnLineId);
    if (!line) return { notice: "That line is not on this return." };

    const draft = ticket.ui.qtyDraft ?? "";
    // An empty keypad means zero here, not an error: "none of this came back" is
    // the single most common answer on a return, and making the recipient type a
    // 0 to say it would be a worse form than the paper one.
    const qty = draft === "" ? 0 : Number(draft);
    if (!Number.isFinite(qty) || qty < 0) return { notice: "Enter how much is coming back." };
    const issued = line.issuedQty ?? 0;
    if (qty > issued) return { notice: `Only ${money(issued)} ${line.unit} were issued — you cannot return more.` };

    line.qty = qty;
    ticket.ui.focusReturnLineId = null;
    ticket.ui.qtyDraft = "";
    return { render: await renderTicket(db, ticket) };
  }

  const res = press(ticket.ui.qtyDraft ?? "", key);
  if ("notice" in res) return res;
  ticket.ui.qtyDraft = res.draft;
  return { render: await renderTicket(db, ticket) };
}

// Add the focused product + location + quantity to the issue cart.
async function commitIssueLine(db: Db, ticket: MaterialTicket, draft: string): Promise<EngineResult> {
  const qty = Number(draft);
  if (!draft || !Number.isFinite(qty) || qty <= 0) return { notice: "Enter a quantity first." };
  if (ticket.lines.length >= MAX_LINES) return { notice: `A ticket can hold at most ${MAX_LINES} materials.` };

  const hit = await focusedHit(db, ticket);
  const line = hit?.lines.find((l) => l.locationId === ticket.ui.focusLocationId);
  if (!hit || !line) return { notice: "That material is no longer available." };
  if (qty > line.qty) return { notice: `Only ${money(line.qty)} ${line.unit} on hand there.` };

  // The same product from the same location twice is one line with a larger
  // quantity, not two lines the recipient has to reconcile by eye when they sign.
  const existing = ticket.lines.find((l) => l.productId === hit.productId && l.locationId === line.locationId);
  if (existing) {
    if (existing.qty + qty > line.qty) return { notice: `Only ${money(line.qty)} ${line.unit} on hand there.` };
    existing.qty += qty;
  } else {
    ticket.lines.push({
      lineId: nextLineId(ticket),
      productId: hit.productId,
      productName: hit.name,
      productNumber: hit.productNumber,
      category: hit.category,
      subcategory: hit.subcategory,
      attributes: hit.attributes,
      locationId: line.locationId,
      locationPath: line.locationPath,
      qty,
      unit: line.unit,
    });
  }

  // Back to the results the store head was searching, so adding a second
  // material is one tap rather than a fresh search.
  ticket.ui.focusProductId = null;
  ticket.ui.focusLocationId = null;
  ticket.ui.qtyDraft = "";
  return { render: await renderTicket(db, ticket) };
}

// Short, stable and never reused — it goes inside callback data (Telegram caps
// that at 64 bytes) and inside the ledger's idempotency keys.
function nextLineId(ticket: MaterialTicket): string {
  let max = 0;
  for (const l of ticket.lines) {
    const n = Number(l.lineId.replace(/^l/, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `l${max + 1}`;
}

export { esc, money };
