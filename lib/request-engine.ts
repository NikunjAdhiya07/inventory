import type { Db } from "mongodb";
import { locationChildren, locationParentIds, locationPathById } from "./locations";
import { searchStock, type StockHit } from "./stock";
import { buttonRows, type InlineKeyboard } from "./telegram";
import { approversFor, mentionList, type Approver } from "./requests";
import {
  MANAGER_ROLE,
  MAX_LINES,
  PURCHASE_ROLE,
  type ItemRequest,
  type RequestLine,
} from "./request-types";

// The request bot's conversation.
//
// Structurally this is the entry bot's anchor-message design applied to a much
// longer-lived object: ONE message per ticket, edited in place from the first
// search through manager Accept (which issues stock and closes the ticket).
// A request group would otherwise fill with the debris of every search anyone ran.
//
// Live inventory path: draft → pending_manager → completed|rejected|cancelled.
// Purchase / awaiting_collection screens stay as legacy handlers for open tickets.
//
// What it deliberately does NOT reuse is the entry bot's step engine. There is
// no linear cursor here — which screen you see is derived from the ticket's
// status and a small `ui` scratch object, so a manager opening a two-day-old
// ticket and a requester mid-search both render correctly from the document
// alone, with no session to still be alive.

export type RenderResult = { text: string; keyboard: InlineKeyboard };

// What handling an update produced: a redraw, a toast, or both.
export type RequestResult = {
  render?: RenderResult;
  notice?: string;
  // Set when the ticket just changed hands, so the webhook knows to re-tag the
  // people who now have to act on it.
  reTag?: boolean;
};

const PAGE_SIZE = 6;
const LOCATIONS_SHOWN = 6;

// Free text from a product name, a location, or something the requester typed
// lands inside an HTML-parsed message. Telegram rejects the whole send when the
// markup does not parse, so an item legitimately called `<3 cable` would take
// the bot down for that ticket rather than just looking odd.
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export async function renderRequest(db: Db, request: ItemRequest): Promise<RenderResult> {
  switch (request.status) {
    case "draft":
      return renderDraft(db, request);
    case "pending_manager":
      return renderPendingManager(db, request);
    case "pending_approval":
      return renderPendingApproval(db, request);
    case "procuring":
      return renderProcuring(request);
    case "awaiting_collection":
      return renderAwaitingCollection(request);
    default:
      return { text: closedText(request), keyboard: [] };
  }
}

async function renderDraft(db: Db, request: ItemRequest): Promise<RenderResult> {
  const ui = request.ui;

  if (request.kind === "purchase") return renderPurchaseDraft(request);
  if (ui.focusProductId && ui.focusLocationId) return renderQtyPad(db, request);
  if (ui.focusProductId) return renderProductDetail(db, request);
  if (ui.query) return renderResults(db, request);
  return renderCart(request);
}

// The results of a search: one button per product, opened to choose where from
// and how many.
async function renderResults(db: Db, request: ItemRequest): Promise<RenderResult> {
  const ui = request.ui;
  const hits = await searchStock(db, ui.query);

  if (!hits.length) {
    return {
      text: `No stock for “${esc(ui.query)}”. Try another name.`,
      keyboard: [
        ...(request.lines.length ? [[{ text: `Cart (${request.lines.length})`, callback_data: "rq:cart" }]] : []),
        [{ text: "✖ Cancel", callback_data: "rq:cancel" }],
      ],
    };
  }

  const pageCount = Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
  // Clamp rather than trust: a narrower search can leave the cursor past the end.
  const page = Math.min(Math.max(ui.page ?? 0, 0), pageCount - 1);
  ui.page = page;
  const start = page * PAGE_SIZE;
  const slice = hits.slice(start, start + PAGE_SIZE);

  // Product-first: name + total on hand. Locations appear after the user taps one.
  const lines = [`<b>${hits.length}</b> match${hits.length === 1 ? "" : "es"} for “${esc(ui.query)}”`, ""];
  for (const [i, hit] of slice.entries()) {
    lines.push(`<b>${start + i + 1}. ${esc(hit.name)}</b> — ${money(hit.total)} ${esc(hit.unit)}`);
  }

  // The callback carries the index into the FULL result list, so paging can
  // never shift what a button means.
  const btns = slice.map((hit, i) => ({
    text: `${start + i + 1}. ${truncate(hit.name, 28)}`,
    callback_data: `rq:s:${start + i}`,
  }));
  const rows: InlineKeyboard = buttonRows(btns, 2);

  const pager = [];
  if (page > 0) pager.push({ text: "◀ Prev", callback_data: "rq:pg:p" });
  if (page < pageCount - 1) pager.push({ text: "Next ▶", callback_data: "rq:pg:n" });
  if (pager.length) rows.push(pager);

  rows.push(footer(request));

  return { text: lines.join("\n"), keyboard: rows };
}

// One product opened: every location holding it, as a button.
async function renderProductDetail(db: Db, request: ItemRequest): Promise<RenderResult> {
  const hit = await focusedHit(db, request);
  if (!hit) {
    return { text: "That product is no longer in stock. Search again.", keyboard: [footer(request)] };
  }

  const lines = [`<b>${esc(hit.name)}</b> — ${money(hit.total)} ${esc(hit.unit)}`, ""];
  for (const l of hit.lines.slice(0, LOCATIONS_SHOWN)) {
    lines.push(`📍 ${esc(l.locationPath)} — <b>${money(l.qty)}</b>`);
  }

  const btns = hit.lines.slice(0, LOCATIONS_SHOWN).map((l, i) => ({
    text: `📍 ${truncate(l.locationPath, 28)} (${money(l.qty)})`,
    callback_data: `rq:l:${i}`,
  }));

  return {
    text: lines.join("\n"),
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:back" }], footer(request)],
  };
}

// The quantity keypad. Same reasoning as the entry bot's: a typed number is a
// second chat message, which is exactly what the single-anchor design avoids.
async function renderQtyPad(db: Db, request: ItemRequest): Promise<RenderResult> {
  const hit = await focusedHit(db, request);
  const line = hit?.lines.find((l) => l.locationId === request.ui.focusLocationId);
  if (!hit || !line) {
    return { text: "That location no longer holds this item. Search again.", keyboard: [footer(request)] };
  }

  const draft = request.ui.qtyDraft ?? "";
  const text =
    `<b>${esc(hit.name)}</b>\n` +
    `${esc(line.locationPath)} · ${money(line.qty)} ${esc(line.unit)} available\n\n` +
    `Qty: <b>${draft || "—"}</b>`;

  const key = (d: string) => ({ text: d, callback_data: `rq:q:${d}` });
  const keyboard: InlineKeyboard = [
    ["1", "2", "3"].map(key),
    ["4", "5", "6"].map(key),
    ["7", "8", "9"].map(key),
    [key("."), key("0"), { text: "⌫", callback_data: "rq:q:del" }],
    [{ text: "✔ Add", callback_data: "rq:q:ok" }],
    [{ text: "⬅ Back", callback_data: "rq:back" }],
    footer(request),
  ];
  return { text, keyboard };
}

// The cart: what has been picked so far, across however many locations.
function renderCart(request: ItemRequest): RenderResult {
  if (!request.lines.length) {
    return {
      text: `<b>Search stock</b>\nType a product name.`,
      keyboard: [[{ text: "✖ Cancel", callback_data: "rq:cancel" }]],
    };
  }

  const lines = [`<b>Cart — ${request.lines.length}</b>`, ""];
  lines.push(...cartLines(request.lines));

  const removes = request.lines.map((l, i) => ({
    text: `✖ ${i + 1}. ${truncate(l.productName, 22)}`,
    callback_data: `rq:rm:${l.lineId}`,
  }));

  return {
    text: lines.join("\n"),
    keyboard: [
      ...buttonRows(removes, 2),
      [{ text: "✅ Submit", callback_data: "rq:sub" }],
      [{ text: "✖ Cancel", callback_data: "rq:cancel" }],
    ],
  };
}

function cartLines(lines: RequestLine[]): string[] {
  return lines.map((l, i) => {
    const head = `<b>${i + 1}. ${esc(l.productName)}</b> × ${money(l.qty)} ${esc(l.unit)}`;
    const mark = l.outcome === "unavailable" ? "  ⚠️ <i>not available</i>" : l.outcome === "issued" ? "  ✅" : "";
    return `${head}\n   📍 ${esc(l.locationPath)}${mark}`;
  });
}

// ---------------------------------------------------------------------------
// Purchase flow (new items)
// ---------------------------------------------------------------------------

const PURCHASE_PROMPTS: Record<string, string> = {
  name: "What item do you need? Send its name.",
  qty: "How many do you need? Send a number.",
  unit: "What unit is that in? (pcs, box, metre…)",
  note: "Anything else the purchase team should know? Send it, or skip.",
};

function renderPurchaseDraft(request: ItemRequest): RenderResult {
  const p = request.purchase;
  const field = request.ui.purchaseField;

  const captured = [
    `🛒 <b>New item purchase request</b>`,
    "",
    `<b>Item:</b> ${p?.name ? esc(p.name) : "<i>—</i>"}`,
    `<b>Quantity:</b> ${p?.qty ? `${money(p.qty)} ${esc(p.unit || "")}`.trim() : "<i>—</i>"}`,
    `<b>Note:</b> ${p?.note ? esc(p.note) : "<i>—</i>"}`,
  ];

  if (field) {
    captured.push("", `➡️ <b>${PURCHASE_PROMPTS[field]}</b>`);
    const rows: InlineKeyboard = [];
    if (field === "note") rows.push([{ text: "Skip ⤼", callback_data: "rq:pf:skip" }]);
    rows.push([{ text: "✖ Cancel", callback_data: "rq:cancel" }]);
    return { text: captured.join("\n"), keyboard: rows };
  }

  captured.push("", "<i>Check it over and submit for approval.</i>");
  return {
    text: captured.join("\n"),
    keyboard: [
      [
        { text: "✏️ Item", callback_data: "rq:pf:name" },
        { text: "✏️ Qty", callback_data: "rq:pf:qty" },
        { text: "✏️ Note", callback_data: "rq:pf:note" },
      ],
      [{ text: "✅ Submit for approval", callback_data: "rq:sub" }],
      [{ text: "✖ Cancel", callback_data: "rq:cancel" }],
    ],
  };
}

// ---------------------------------------------------------------------------
// Post-submission screens
// ---------------------------------------------------------------------------

function ticketHeader(request: ItemRequest, title: string): string[] {
  return [
    `🎫 <b>${esc(request.ticketNumber ?? "")}</b> — ${title}`,
    `Requested by <b>${esc(request.requesterName)}</b>`,
    "",
  ];
}

async function renderPendingManager(db: Db, request: ItemRequest): Promise<RenderResult> {
  const approvers = await approversFor(db, MANAGER_ROLE);
  const lines = ticketHeader(request, "waiting for approval");
  lines.push(...cartLines(request.lines));
  lines.push("", tagLine(approvers, MANAGER_ROLE));

  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: "✔ Accept", callback_data: "rq:acc" },
        { text: "✖ Reject", callback_data: "rq:rej" },
      ],
      [{ text: "🗑 Withdraw", callback_data: "rq:cancel" }],
    ],
  };
}

async function renderPendingApproval(db: Db, request: ItemRequest): Promise<RenderResult> {
  const approvers = await approversFor(db, PURCHASE_ROLE);
  const p = request.purchase;
  const lines = ticketHeader(request, "waiting for purchase approval");
  lines.push(
    `<b>Item:</b> ${esc(p?.name ?? "")}`,
    `<b>Quantity:</b> ${money(p?.qty ?? 0)} ${esc(p?.unit ?? "")}`.trim()
  );
  if (p?.note) lines.push(`<b>Note:</b> ${esc(p.note)}`);
  lines.push("", tagLine(approvers, PURCHASE_ROLE));

  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: "✔ Approve", callback_data: "rq:papp" },
        { text: "✖ Reject", callback_data: "rq:prej" },
      ],
      [{ text: "🗑 Withdraw", callback_data: "rq:cancel" }],
    ],
  };
}

function renderProcuring(request: ItemRequest): RenderResult {
  const p = request.purchase;
  const lines = ticketHeader(request, "approved — being purchased");
  lines.push(`<b>Item:</b> ${esc(p?.name ?? "")}`, `<b>Quantity:</b> ${money(p?.qty ?? 0)} ${esc(p?.unit ?? "")}`.trim());
  lines.push("", ...historyLines(request));
  lines.push("", "<i>The purchase team marks this delivered once the item arrives.</i>");

  return {
    text: lines.join("\n"),
    keyboard: [
      [{ text: "📦 Mark delivered", callback_data: "rq:deliv" }],
      [{ text: "🗑 Cancel", callback_data: "rq:cancel" }],
    ],
  };
}

function renderAwaitingCollection(request: ItemRequest): RenderResult {
  // Legacy only — new Accepts complete immediately. Kept so older tickets can finish.
  const lines = ticketHeader(request, "ready to collect");
  if (request.kind === "purchase") {
    const p = request.purchase;
    lines.push(`<b>Item:</b> ${esc(p?.name ?? "")}`, `<b>Quantity:</b> ${money(p?.qty ?? 0)} ${esc(p?.unit ?? "")}`.trim());
  } else {
    lines.push(...cartLines(request.lines));
    const short = request.lines.filter((l) => l.outcome === "unavailable");
    if (short.length) {
      lines.push("", `⚠️ <i>${short.length} line(s) could not be filled and were not issued.</i>`);
    }
  }
  lines.push("", ...historyLines(request));
  lines.push("", `${esc(request.requesterHandle || request.requesterName)} — confirm once you have the items.`);

  return {
    text: lines.join("\n"),
    keyboard: [
      [{ text: "📥 Received", callback_data: "rq:got" }],
      [{ text: "🗑 Cancel", callback_data: "rq:cancel" }],
    ],
  };
}

function closedText(request: ItemRequest): string {
  const titles: Record<string, string> = {
    completed: "✅ completed — stock issued",
    rejected: "⛔ rejected",
    cancelled: "🚫 cancelled",
  };
  const lines = ticketHeader(request, titles[request.status] ?? request.status);
  if (request.kind === "purchase" && request.purchase) {
    lines.push(`<b>Item:</b> ${esc(request.purchase.name)} × ${money(request.purchase.qty)} ${esc(request.purchase.unit)}`.trim());
  } else {
    lines.push(...cartLines(request.lines));
    if (request.status === "completed") {
      const issued = request.lines.filter((l) => l.outcome === "issued");
      const short = request.lines.filter((l) => l.outcome === "unavailable");
      if (issued.length) {
        lines.push(
          "",
          `<b>Issued:</b> ${issued.map((l) => `−${money(l.qty)} ${esc(l.unit)} ${esc(l.productName)}`).join("; ")}`
        );
      }
      if (short.length) {
        lines.push(`⚠️ <i>${short.length} line(s) could not be filled.</i>`);
      }
    }
  }
  lines.push("", ...historyLines(request));
  return lines.join("\n");
}

function historyLines(request: ItemRequest): string[] {
  return request.history.slice(-5).map((h) => `• ${esc(h.by)} — ${esc(h.what)}`);
}

function tagLine(approvers: Approver[], role: string): string {
  const mentions = mentionList(approvers);
  if (!mentions) {
    return `⚠️ <i>Nobody holds the ${esc(role)} role yet — an admin has to assign it before this can be actioned.</i>`;
  }
  return `${mentions} — please review. <i>(${esc(role)})</i>`;
}

function footer(request: ItemRequest): InlineKeyboard[number] {
  const row = [];
  if (request.lines.length) row.push({ text: `🧺 Cart (${request.lines.length})`, callback_data: "rq:cart" });
  row.push({ text: "✖ Cancel", callback_data: "rq:cancel" });
  return row;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// The product the requester currently has open, re-resolved from the live search
// rather than remembered. Stock can change between taps, and rendering a
// remembered snapshot would offer quantities that no longer exist.
async function focusedHit(db: Db, request: ItemRequest): Promise<StockHit | null> {
  const hits = await searchStock(db, request.ui.query);
  return hits.find((h) => h.productId === request.ui.focusProductId) ?? null;
}

// ---------------------------------------------------------------------------
// Typed input
// ---------------------------------------------------------------------------

export async function applyRequestMessage(
  db: Db,
  request: ItemRequest,
  text: string
): Promise<RequestResult> {
  const trimmed = text.trim();
  if (!trimmed) return { render: await renderRequest(db, request) };

  // Only a draft accepts typing. A submitted ticket is driven by its buttons, so
  // chatter in the group must not disturb it.
  if (request.status !== "draft") return {};

  if (request.kind === "purchase") return applyPurchaseText(db, request, trimmed);

  // Anything typed while building an inventory request is a search.
  request.ui.query = trimmed.slice(0, 60);
  request.ui.page = 0;
  request.ui.focusProductId = null;
  request.ui.focusLocationId = null;
  request.ui.qtyDraft = "";
  return { render: await renderRequest(db, request) };
}

async function applyPurchaseText(db: Db, request: ItemRequest, text: string): Promise<RequestResult> {
  const field = request.ui.purchaseField;
  if (!field) return { render: await renderRequest(db, request) };

  const p = (request.purchase ??= { name: "", qty: 0, unit: "", note: "" });

  if (field === "qty") {
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) return { notice: "Send a positive number." };
    p.qty = n;
    // Unit follows quantity naturally, so ask for it straight away rather than
    // sending the requester back to a menu to find it.
    request.ui.purchaseField = "unit";
    return { render: await renderRequest(db, request) };
  }

  if (field === "name") {
    p.name = text.slice(0, 120);
    request.ui.purchaseField = p.qty ? null : "qty";
    return { render: await renderRequest(db, request) };
  }

  if (field === "unit") {
    p.unit = text.slice(0, 30);
    request.ui.purchaseField = null;
    return { render: await renderRequest(db, request) };
  }

  p.note = text.slice(0, 400);
  request.ui.purchaseField = null;
  return { render: await renderRequest(db, request) };
}

// ---------------------------------------------------------------------------
// Cart callbacks (the requester building a draft)
// ---------------------------------------------------------------------------

// Handles only the draft-stage callbacks. Status transitions live in the webhook
// so that permission checks sit next to them.
export async function applyDraftCallback(db: Db, request: ItemRequest, data: string): Promise<RequestResult> {
  const ui = request.ui;

  if (data === "rq:cart") {
    ui.query = "";
    ui.focusProductId = null;
    ui.focusLocationId = null;
    return { render: await renderRequest(db, request) };
  }

  if (data === "rq:back") {
    // One step back out of whatever is open: quantity → locations → results.
    if (ui.focusLocationId) ui.focusLocationId = null;
    else if (ui.focusProductId) ui.focusProductId = null;
    else ui.query = "";
    ui.qtyDraft = "";
    return { render: await renderRequest(db, request) };
  }

  if (data === "rq:new") {
    // Purchase entry is retired for new tickets. Legacy drafts already on the
    // purchase path keep their existing UI via purchaseField handlers below.
    if (request.kind === "purchase" && request.purchase) {
      request.ui.purchaseField = request.ui.purchaseField ?? "name";
      return { render: await renderRequest(db, request) };
    }
    return {
      notice: "Purchase requests are no longer started here. Search stock and submit — an Inventory Manager Accept issues the items.",
    };
  }

  if (data.startsWith("rq:pf:")) {
    const field = data.slice("rq:pf:".length);
    ui.purchaseField = field === "skip" ? null : (field as "name" | "qty" | "unit" | "note");
    return { render: await renderRequest(db, request) };
  }

  if (data.startsWith("rq:pg:")) {
    ui.page = Math.max(0, (ui.page ?? 0) + (data === "rq:pg:n" ? 1 : -1));
    return { render: await renderRequest(db, request) };
  }

  if (data.startsWith("rq:s:")) {
    const hits = await searchStock(db, ui.query);
    const hit = hits[Number(data.slice("rq:s:".length))];
    if (!hit) return { notice: "That item is no longer available." };
    ui.focusProductId = hit.productId;
    ui.focusLocationId = null;
    ui.qtyDraft = "";
    return { render: await renderRequest(db, request) };
  }

  if (data.startsWith("rq:l:")) {
    const hit = await focusedHit(db, request);
    const line = hit?.lines[Number(data.slice("rq:l:".length))];
    if (!line) return { notice: "That location is no longer available." };
    ui.focusLocationId = line.locationId;
    ui.qtyDraft = "";
    return { render: await renderRequest(db, request) };
  }

  if (data.startsWith("rq:q:")) return applyQtyKey(db, request, data.slice("rq:q:".length));

  if (data.startsWith("rq:rm:")) {
    const lineId = data.slice("rq:rm:".length);
    const before = request.lines.length;
    request.lines = request.lines.filter((l) => l.lineId !== lineId);
    if (request.lines.length === before) return { notice: "That item is already off the request." };
    return { render: await renderRequest(db, request) };
  }

  return { notice: "Use the buttons above." };
}

async function applyQtyKey(db: Db, request: ItemRequest, pressed: string): Promise<RequestResult> {
  const ui = request.ui;
  let draft = ui.qtyDraft ?? "";

  if (pressed === "ok") return commitLine(db, request, draft);

  if (pressed === "del") draft = draft.slice(0, -1);
  else if (pressed === ".") {
    if (draft.includes(".")) return { notice: "Only one decimal point." };
    draft = draft === "" ? "0." : `${draft}.`;
  } else {
    if (draft.replace(".", "").length >= 9) return { notice: "That's as large as a quantity can get." };
    draft = draft === "0" ? pressed : draft + pressed;
  }

  ui.qtyDraft = draft;
  return { render: await renderRequest(db, request) };
}

// Add the focused product+location+quantity to the cart.
async function commitLine(db: Db, request: ItemRequest, draft: string): Promise<RequestResult> {
  const qty = Number(draft);
  if (!draft || !Number.isFinite(qty) || qty <= 0) return { notice: "Enter a quantity first." };
  if (request.lines.length >= MAX_LINES) {
    return { notice: `A request can hold at most ${MAX_LINES} items.` };
  }

  const hit = await focusedHit(db, request);
  const line = hit?.lines.find((l) => l.locationId === request.ui.focusLocationId);
  if (!hit || !line) return { notice: "That item is no longer available." };
  if (qty > line.qty) return { notice: `Only ${money(line.qty)} ${line.unit} available there.` };

  // The same product from the same location twice is one line with a larger
  // quantity, not two lines a manager has to reconcile by eye.
  const existing = request.lines.find(
    (l) => l.productId === hit.productId && l.locationId === line.locationId
  );
  if (existing) {
    if (existing.qty + qty > line.qty) return { notice: `Only ${money(line.qty)} ${line.unit} available there.` };
    existing.qty += qty;
  } else {
    request.lines.push({
      lineId: nextLineId(request),
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

  // Back to the results the requester was searching, so adding a second item
  // takes one tap rather than a fresh search.
  request.ui.focusProductId = null;
  request.ui.focusLocationId = null;
  request.ui.qtyDraft = "";
  return { render: await renderRequest(db, request) };
}

// Short, stable and never reused — it ends up inside callback data (which
// Telegram caps at 64 bytes) and inside the ledger's idempotency keys.
function nextLineId(request: ItemRequest): string {
  let max = 0;
  for (const l of request.lines) {
    const n = Number(l.lineId.replace(/^l/, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `l${max + 1}`;
}

// ---------------------------------------------------------------------------
// Delivery of a purchased item
// ---------------------------------------------------------------------------

// Marking a purchase delivered asks one question first: does the item go into
// stock, or straight to the requester?
//
// Both are real. A box of 50 cables bought against one request belongs in
// inventory, where the surplus stays findable. A laptop bought for one person
// does not — putting it in stock only to issue it again in the same breath
// would be bookkeeping theatre.
export function renderDeliveryChoice(request: ItemRequest): RenderResult {
  const p = request.purchase;
  const lines = ticketHeader(request, "delivered — where does it go?");
  lines.push(`<b>Item:</b> ${esc(p?.name ?? "")} × ${money(p?.qty ?? 0)} ${esc(p?.unit ?? "")}`.trim());
  lines.push(
    "",
    "<b>Receive into stock</b> — logs it at a location so it is searchable, then hands the requester their quantity.",
    "<b>Hand over directly</b> — closes the ticket without touching inventory."
  );
  return {
    text: lines.join("\n"),
    keyboard: [
      [{ text: "📦 Receive into stock", callback_data: "rq:dl:stock" }],
      [{ text: "🤝 Hand over directly", callback_data: "rq:dl:direct" }],
      [{ text: "⬅ Back", callback_data: "rq:dl:back" }],
    ],
  };
}

// The location picker used when a purchased item is received into stock. Same
// drill-down the entry bot uses, driven off the request's own cursor.
export async function renderDeliveryLocation(db: Db, request: ItemRequest): Promise<RenderResult> {
  const cursor = request.ui.locCursor ?? null;
  const [children, parents, here] = await Promise.all([
    locationChildren(db, cursor),
    locationParentIds(db),
    cursor ? locationPathById(db, cursor) : Promise.resolve(""),
  ]);

  const btns = children.map((c, i) => ({
    text: `${parents.has(c._id.toString()) ? "📁" : "📍"} ${truncate(String(c.name), 24)}`,
    callback_data: `rq:dloc:${i}`,
  }));
  const rows: InlineKeyboard = buttonRows(btns, 2);
  if (cursor) rows.push([{ text: "✔ Receive here", callback_data: "rq:dloc:sel" }]);
  rows.push([{ text: "⬅ Back", callback_data: "rq:dl:back" }]);

  const lines = ticketHeader(request, "where is it being stored?");
  if (here) lines.push(`<i>Current: ${esc(here)}</i>`);
  lines.push("", "<i>Drill into the location you are putting it in.</i>");
  return { text: lines.join("\n"), keyboard: rows };
}

// Move the delivery location cursor in response to a `rq:dloc:` tap. Returns the
// chosen location id once the picker settles on one, or null while still
// drilling.
export async function applyDeliveryLocation(
  db: Db,
  request: ItemRequest,
  data: string
): Promise<{ chosen?: string; notice?: string }> {
  const ui = request.ui;
  const cursor = ui.locCursor ?? null;

  if (data === "rq:dloc:sel") {
    if (!cursor) return { notice: "Drill into a location first." };
    return { chosen: cursor };
  }

  const children = await locationChildren(db, cursor);
  const chosen = children[Number(data.slice("rq:dloc:".length))];
  if (!chosen) return { notice: "That location is no longer available." };

  const chosenId = chosen._id.toString();
  const parents = await locationParentIds(db);
  // A node with nothing under it can only ever be the answer, so tapping it
  // selects rather than opening an empty level nobody can confirm.
  if (!parents.has(chosenId)) return { chosen: chosenId };

  if (cursor) (ui.locStack ??= []).push(cursor);
  ui.locCursor = chosenId;
  return {};
}

export { esc, money };
