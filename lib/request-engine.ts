import type { Db } from "mongodb";
import { locationChildren, locationParentIds, locationPathById } from "./locations";
import {
  applyMoveCallback,
  applyMoveMessage,
  categoryPathOf,
  categoryPickOptions,
  clearCategoryPath,
  clearMoveUi,
  continueAfterProductPick,
  focusedProduct,
  isMoveCallback,
  renderMoveFlow,
  resolveCategoryChildren,
  setCategoryPath,
  startSearchFlow,
} from "./move-engine";
import { rootCategoryNames } from "./categories";
import { parseQuantityRepeat, pressQuantityKey, quantityRepeatHint, draftQtyParts, formatQtyUnit, formatItemQtySummary } from "./quantity-repeat";
import { getSearchMoveWorkflow, leadInHasKind, leadInNode, collectQuestions, resolveStockEffectFromBranch } from "./search-move-workflow";
import { resolveStockEffectFromAnswers } from "./movement-questions";
import { activeMovementTypes, toMovementType } from "./movements";
import { lookupProducts, type StockHit } from "./stock";
import { buttonRows, type InlineKeyboard } from "./telegram";
import { approversFor, mentionList, note, saveRequest, type Approver } from "./requests";
import { BORROW_MOVEMENT_CODE, postBorrowing } from "./borrowing";
import {
  findOutboundShortage,
  isInboundMovement,
  persistOutboundShortage,
  type OutboundShortage,
} from "./outbound-stock";
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

  // Entire search-group draft is driven by the Workflows flowchart (same tree as the builder).
  if (ui.flowNodeId || ui.focusProductId || ui.query) {
    return renderMoveFlow(db, request);
  }
  return renderCart(request);
}

function uniqueCategories(hits: StockHit[]): string[] {
  const set = new Set<string>();
  for (const h of hits) {
    const cat = String(h.category ?? "").trim() || "Other";
    set.add(cat);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function uniqueSubcategories(hits: StockHit[]): string[] {
  const set = new Set<string>();
  for (const h of hits) {
    set.add(subcategoryLabel(h.subcategory));
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function subcategoryLabel(raw: unknown): string {
  const s = String(raw ?? "").trim();
  return s || "(none)";
}

function hitMatchesSubcategory(hit: StockHit, focusSub: string): boolean {
  return subcategoryLabel(hit.subcategory) === focusSub;
}

function filterSearchHits(raw: StockHit[], ui: ItemRequest["ui"]): StockHit[] {
  let hits = raw;
  if (ui.focusCategory) {
    hits = hits.filter((h) => (String(h.category ?? "").trim() || "Other") === ui.focusCategory);
  }
  if (ui.focusSubcategory) {
    hits = hits.filter((h) => hitMatchesSubcategory(h, ui.focusSubcategory!));
  }
  return hits;
}

/** Selectable list: which category of matches (e.g. MS Pipe vs PVC Pipe). */
function renderCategoryPick(request: ItemRequest, categories: string[]): RenderResult {
  const lines = [
    `<b>${categories.length} categories</b> match “${esc(request.ui.query)}”`,
    "",
    "Pick a category:",
  ];
  const btns = categories.map((c, i) => ({
    text: truncate(c, 30),
    callback_data: `rq:cat:${i}`,
  }));
  return {
    text: lines.join("\n"),
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:back" }], footer(request)],
  };
}

/** Selectable list: subcategories available inside the chosen category. */
function renderSubcategoryPick(request: ItemRequest, subcategories: string[]): RenderResult {
  const cat = request.ui.focusCategory || "Category";
  const lines = [
    `<b>${esc(cat)}</b>`,
    `<b>${subcategories.length} subcategor${subcategories.length === 1 ? "y" : "ies"}</b> match “${esc(request.ui.query)}”`,
    "",
    "Pick a subcategory:",
  ];
  const btns = subcategories.map((s, i) => ({
    text: truncate(s, 30),
    callback_data: `rq:sub:${i}`,
  }));
  return {
    text: lines.join("\n"),
    keyboard: [
      ...buttonRows(btns, 1),
      [{ text: "⬅ Categories", callback_data: "rq:back" }],
      footer(request),
    ],
  };
}

/** Selectable list: which shelf before Choose action. */
async function renderIntentLocationPick(db: Db, request: ItemRequest): Promise<RenderResult> {
  const hit = await focusedHit(db, request);
  if (!hit) {
    return { text: "That product is no longer available. Search again.", keyboard: [footer(request)] };
  }

  // One location (or none) — skip the list and continue the flowchart.
  if (hit.lines.length <= 1) {
    request.ui.focusLocationId = hit.lines[0]?.locationId ?? null;
    request.ui.intentLocationPicked = true;
    return renderMoveFlow(db, request);
  }

  const lines = [
    `<b>${esc(hit.name)}</b>${hit.category ? ` · ${esc(hit.category)}` : ""}`,
    `${money(hit.total)} ${esc(hit.unit)} on hand across ${hit.lines.length} locations`,
    "",
    "Pick a storage location:",
  ];
  const btns = hit.lines.slice(0, LOCATIONS_SHOWN).map((l, i) => ({
    text: `📍 ${truncate(l.locationPath, 26)} (${money(l.qty)})`,
    callback_data: `rq:iloc:${i}`,
  }));
  return {
    text: lines.join("\n"),
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:back" }], footer(request)],
  };
}

// The results of a search: one button per product. Includes zero-stock items so
// Entries-bot receipts / purchase returns can start from nothing on the shelf;
// the product screen then branches into Record movement vs Request item.
async function renderResults(db: Db, request: ItemRequest, allHits?: StockHit[]): Promise<RenderResult> {
  const ui = request.ui;
  const raw = allHits ?? (await lookupProducts(db, ui.query));
  const hits = filterSearchHits(raw, ui);

  const scopeLabel = [ui.focusCategory, ui.focusSubcategory].filter(Boolean).join(" › ");

  if (!hits.length) {
    return {
      text: scopeLabel
        ? `No items in “${esc(scopeLabel)}” for “${esc(ui.query)}”. Pick another filter.`
        : `No items for “${esc(ui.query)}”. Try another name or a reference tag (e.g. “pipe”).`,
      keyboard: [
        ...(ui.focusSubcategory || ui.focusCategory ? [[{ text: "⬅ Back", callback_data: "rq:back" }]] : []),
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

  const header = scopeLabel
    ? `<b>${hits.length}</b> in “${esc(scopeLabel)}” for “${esc(ui.query)}”`
    : `<b>${hits.length}</b> match${hits.length === 1 ? "" : "es"} for “${esc(ui.query)}”`;
  const lines = [header, "Pick an item:", ""];
  for (const [i, hit] of slice.entries()) {
    const sub = hit.subcategory ? ` · ${esc(hit.subcategory)}` : "";
    const cat = !ui.focusCategory && hit.category ? ` · ${esc(hit.category)}` : "";
    lines.push(`<b>${start + i + 1}. ${esc(hit.name)}</b>${cat}${sub} — ${money(hit.total)} ${esc(hit.unit)}`);
  }

  // The callback carries the index into the FILTERED result list.
  const btns = slice.map((hit, i) => ({
    text: `${start + i + 1}. ${truncate(hit.name, 28)}`,
    callback_data: `rq:s:${start + i}`,
  }));
  const rows: InlineKeyboard = buttonRows(btns, 1);

  const pager = [];
  if (page > 0) pager.push({ text: "◀ Prev", callback_data: "rq:pg:p" });
  if (page < pageCount - 1) pager.push({ text: "Next ▶", callback_data: "rq:pg:n" });
  if (pager.length) rows.push(pager);

  if (ui.focusSubcategory) rows.push([{ text: "⬅ Subcategories", callback_data: "rq:back" }]);
  else if (ui.focusCategory) rows.push([{ text: "⬅ Categories", callback_data: "rq:back" }]);
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
  const parts = draftQtyParts(draft);
  const unit = line.unit || hit.unit || "";
  const qtyLine = `Qty: <b>${esc(parts.qtyLabel)}</b>${unit ? ` ${esc(unit)}` : ""}`;
  const entriesLine = parts.hasTimes ? `\nEntries: <b>${esc(parts.entriesLabel || "—")}</b>` : "";
  const text =
    `<b>${esc(hit.name)}</b>\n` +
    `${esc(line.locationPath)} · ${money(line.qty)} ${esc(unit)} available\n\n` +
    `How many?\n\n${qtyLine}${entriesLine}\n\n` +
    quantityRepeatHint();

  const key = (d: string) => ({ text: d, callback_data: `rq:q:${d}` });
  const keyboard: InlineKeyboard = [
    ["1", "2", "3"].map(key),
    ["4", "5", "6"].map(key),
    ["7", "8", "9"].map(key),
    [key("."), key("0"), { text: "⌫", callback_data: "rq:q:del" }],
    [
      { text: "×", callback_data: "rq:q:x" },
      { text: "✔ Add", callback_data: "rq:q:ok" },
    ],
    [{ text: "⬅ Back", callback_data: "rq:back" }],
    footer(request),
  ];
  return { text, keyboard };
}

// The cart: what has been picked so far, across however many locations.
function renderCart(request: ItemRequest): RenderResult {
  if (!request.lines.length) {
    return {
      text: `<b>Search stock</b>\nType a product name to request items or record a movement.`,
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
      [{ text: "➕ Add Another Item", callback_data: "rq:again" }],
      [{ text: "✅ Submit", callback_data: "rq:sub" }],
      [{ text: "✖ Cancel", callback_data: "rq:cancel" }],
    ],
  };
}

function cartLines(lines: RequestLine[]): string[] {
  return lines.map((l, i) => {
    const moveLabel = l.movementName ? `${esc(l.movementName)} · ` : "";
    // Em dash — never use × between item and quantity (× means entry repeat).
    const head = `<b>${i + 1}. ${moveLabel}${esc(l.productName)}</b> — ${esc(formatQtyUnit(l.qty, l.unit))}`;
    const mark =
      l.outcome === "unavailable"
        ? "  ⚠️ <i>not available</i>"
        : l.outcome === "issued" || l.outcome === "recorded"
          ? "  ✅"
          : "";
    const extras: string[] = [];
    if (l.fromLocationId && l.toLocationId) {
      extras.push(`   From: ${esc(l.fromLocationPath || l.locationPath)}`);
      extras.push(`   To: ${esc(l.toLocationPath || "—")}`);
      if (l.outcome === "unavailable") extras[extras.length - 1] += "  ⚠️ <i>not available</i>";
      else if (l.outcome === "issued" || l.outcome === "recorded") extras[extras.length - 1] += "  ✅";
    } else {
      extras.push(`   📍 ${esc(l.locationPath)}${mark}`);
    }
    if (l.vendorName) extras.push(`   Vendor: ${esc(l.vendorName)}`);
    if (l.plantName) extras.push(`   From Plant: ${esc(l.plantName)}`);
    if (l.departmentName) extras.push(`   Department: ${esc(l.departmentName)}`);
    for (const a of l.answers ?? []) {
      extras.push(`   ${esc(a.label)}: ${esc(a.display)}`);
    }
    if (l.reference) extras.push(`   Ref: ${esc(l.reference)}`);
    return [head, ...extras].join("\n");
  });
}

function renderOutOfStock(
  request: ItemRequest,
  shortage: OutboundShortage,
  movementName?: string
): RenderResult {
  const lines = [
    `⚠️ <b>Out of stock</b>`,
    "",
    movementName ? `<b>${esc(movementName)}</b>` : "",
    `Item: ${esc(shortage.productName)}`,
    `Location: ${esc(shortage.locationPath)}`,
    `Requested: ${money(shortage.qtyRequested)} ${esc(shortage.unit)}`,
    `Available: ${money(shortage.available)} ${esc(shortage.unit)}`,
    "",
    "<i>This shortage was recorded. Enter a lower quantity or pick another location.</i>",
  ].filter(Boolean);
  const kb: InlineKeyboard = [];
  if (request.ui.flowNodeId) {
    kb.push([{ text: "⬅ Back", callback_data: "rq:mv:back" }]);
  }
  if (request.lines.length) {
    kb.push([{ text: `🧺 Cart (${request.lines.length})`, callback_data: "rq:cart" }]);
  }
  kb.push([{ text: "✖ Cancel", callback_data: "rq:cancel" }]);
  return { text: lines.join("\n"), keyboard: kb };
}

/** Snapshot Expected vs Received for New Purchase cart lines. */
export function resolvePurchaseStatus(
  moveCode: string | undefined,
  answers?: { label: string; display: string }[]
): "expected" | "received" | undefined {
  if (moveCode !== "new-purchase") return undefined;
  const hit = answers?.find(
    (a) =>
      /expected\s*\/\s*received/i.test(a.label) ||
      /status/i.test(a.label) ||
      a.label === "Expected / Received Status"
  );
  const display = String(hit?.display ?? "");
  if (/received/i.test(display) && !/expected|ordered/i.test(display)) return "received";
  if (/ordered|expected/i.test(display)) return "expected";
  if (/received/i.test(display)) return "received";
  // Simple New Purchase flow has no status question — treat as received stock-in.
  return "received";
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

// The product the requester currently has open, re-resolved from the live
// catalogue (including zero-stock) rather than remembered. Stock can change
// between taps, and rendering a remembered snapshot would offer quantities that
// no longer exist.
async function focusedHit(db: Db, request: ItemRequest): Promise<StockHit | null> {
  return focusedProduct(db, request);
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

  // Reference / remarks for a stock movement are typed answers, not a new search.
  const moveMsg = await applyMoveMessage(db, request, trimmed);
  if (moveMsg) {
    if (moveMsg.render) return { render: moveMsg.render };
    if (moveMsg.notice) return { notice: moveMsg.notice };
  }

  // Anything else typed while building an inventory request starts the flowchart from Search.
  return { render: await startSearchFlow(db, request, trimmed) };
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
export async function applyDraftCallback(
  db: Db,
  request: ItemRequest,
  data: string,
  by = "Unknown"
): Promise<RequestResult> {
  const ui = request.ui;

  if (isMoveCallback(data)) {
    const res = await applyMoveCallback(db, request, data, by);
    if (res.addToCart) {
      // A borrow never reaches the cart. The person is holding the item, so the
      // ledger has to agree with the shelf now rather than after a manager
      // Accept that may be hours away.
      if (request.ui.moveTypeCode === BORROW_MOVEMENT_CODE) {
        return commitBorrow(db, request, by);
      }
      const draft = request.ui.moveQtyDraft || request.ui.qtyDraft || "";
      if (!request.ui.focusLocationId && request.ui.moveLocationId) {
        request.ui.focusLocationId = request.ui.moveLocationId;
      }
      request.ui.qtyDraft = draft;
      const committed = await commitLine(db, request, draft);
      clearMoveUi(request.ui);
      return committed;
    }
    if (res.render) return { render: res.render };
    if (res.notice) return { notice: res.notice };
    return { notice: "Use the buttons above." };
  }

  if (data === "rq:cart") {
    ui.query = "";
    ui.focusProductId = null;
    ui.focusLocationId = null;
    clearCategoryPath(ui);
    ui.intentLocationPicked = false;
    clearMoveUi(ui);
    return { render: await renderRequest(db, request) };
  }

  if (data === "rq:back") {
    // Flowchart-aware back: leave product → filters → search → cart
    if (ui.flowNodeId && ui.focusProductId && !ui.moveTypeCode) {
      // In lead-in after product (e.g. location / select movement) — drop product, return to search results
      ui.focusProductId = null;
      ui.focusLocationId = null;
      ui.intentLocationPicked = false;
      clearMoveUi(ui);
      const wf = await getSearchMoveWorkflow(db, request.chatId);
      ui.flowNodeId = wf.rootId;
      ui.intent = "move";
      return { render: await renderMoveFlow(db, request) };
    }
    if (ui.focusLocationId && ui.intent === "request") {
      ui.focusLocationId = null;
      ui.qtyDraft = "";
    } else if (ui.focusProductId) {
      ui.focusProductId = null;
      ui.focusLocationId = null;
      ui.intentLocationPicked = false;
      clearMoveUi(ui);
      if (ui.query) {
        const wf = await getSearchMoveWorkflow(db, request.chatId);
        ui.flowNodeId = wf.rootId;
        ui.intent = "move";
        return { render: await renderMoveFlow(db, request) };
      }
    } else if (categoryPathOf(ui).length) {
      const path = categoryPathOf(ui);
      path.pop();
      setCategoryPath(ui, path);
      ui.page = 0;
      if (!path.length) {
        // Back to empty path: if master still auto-matches the query to one
        // category, clear the search instead of bouncing into a one-item list.
        const options = await categoryPickOptions(db, ui.query);
        if (options.length <= 1) {
          ui.query = "";
          clearMoveUi(ui);
        }
      }
    } else {
      ui.query = "";
      clearMoveUi(ui);
    }
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
    if (ui.flowNodeId || ui.query) return { render: await renderMoveFlow(db, request) };
    return { render: await renderRequest(db, request) };
  }

  if (data.startsWith("rq:cat:")) {
    // Indices match Category Master roots shown on the pick keyboard.
    const categories = await rootCategoryNames(db);
    const cat = categories[Number(data.slice("rq:cat:".length))];
    if (!cat) return { notice: "That category is no longer available." };
    setCategoryPath(ui, [cat]);
    ui.page = 0;
    ui.focusProductId = null;
    ui.focusLocationId = null;
    ui.intentLocationPicked = false;
    // Stay on pick_category (or search) node — renderMoveFlow drills children / items.
    const wf = await getSearchMoveWorkflow(db, request.chatId);
    if (leadInHasKind(wf, "pick_category")) {
      const catNode = leadInNode(wf, "pick_category");
      if (catNode) ui.flowNodeId = catNode.id;
    }
    ui.intent = "move";
    return { render: await renderMoveFlow(db, request) };
  }

  if (data.startsWith("rq:sub:")) {
    const path = categoryPathOf(ui);
    if (!path.length) return { notice: "Pick a category first." };
    const raw = await lookupProducts(db, ui.query);
    const rootHits = raw.filter((h) => (String(h.category ?? "").trim() || "Other") === path[0]);
    const kids = await resolveCategoryChildren(db, path, rootHits);
    const next = kids[Number(data.slice("rq:sub:".length))];
    if (!next) return { notice: "That option is no longer available." };
    setCategoryPath(ui, [...path, next]);
    ui.page = 0;
    ui.focusProductId = null;
    ui.focusLocationId = null;
    ui.intentLocationPicked = false;
    ui.intent = "move";
    const wf = await getSearchMoveWorkflow(db, request.chatId);
    if (leadInHasKind(wf, "pick_category")) {
      const catNode = leadInNode(wf, "pick_category");
      // Stay on pick_category while more children remain; otherwise back to search for items.
      const deeper = await resolveCategoryChildren(db, categoryPathOf(ui), rootHits);
      ui.flowNodeId = deeper.length ? catNode?.id ?? wf.rootId : wf.rootId;
    } else {
      ui.flowNodeId = wf.rootId;
    }
    return { render: await renderMoveFlow(db, request) };
  }

  if (data.startsWith("rq:s:")) {
    const raw = await lookupProducts(db, ui.query);
    const hits = filterSearchHits(raw, ui);
    const hit = hits[Number(data.slice("rq:s:".length))];
    if (!hit) return { notice: "That item is no longer available." };
    ui.focusProductId = hit.productId;
    ui.focusLocationId = null;
    ui.intentLocationPicked = false;
    ui.qtyDraft = "";
    // Product Master category is source of truth — do not re-ask.
    const catPath = [hit.category, hit.subcategory].map((s) => String(s ?? "").trim()).filter(Boolean);
    if (catPath.length) setCategoryPath(ui, catPath);
    return { render: await continueAfterProductPick(db, request) };
  }

  if (data.startsWith("rq:iloc:")) {
    const hit = await focusedHit(db, request);
    const line = hit?.lines[Number(data.slice("rq:iloc:".length))];
    if (!line) return { notice: "That location is no longer available." };
    ui.focusLocationId = line.locationId;
    ui.intentLocationPicked = true;
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

  if (data === "rq:again") {
    ui.query = "";
    ui.focusProductId = null;
    ui.focusLocationId = null;
    clearCategoryPath(ui);
    ui.intentLocationPicked = false;
    clearMoveUi(ui);
    return {
      render: {
        text: `<b>Add another item</b>\n\nType a product name to search.`,
        keyboard: [
          ...(request.lines.length
            ? [[{ text: `🛒 View Cart (${request.lines.length})`, callback_data: "rq:cart" }]]
            : []),
          [{ text: "✖ Cancel", callback_data: "rq:cancel" }],
        ],
      },
    };
  }

  return { notice: "Use the buttons above." };
}

async function applyQtyKey(db: Db, request: ItemRequest, pressed: string): Promise<RequestResult> {
  const ui = request.ui;
  let draft = ui.qtyDraft ?? "";

  if (pressed === "ok") return commitLine(db, request, draft);

  const next = pressQuantityKey(draft, pressed);
  if (next.notice) return { notice: next.notice };
  ui.qtyDraft = next.value;
  return { render: await renderRequest(db, request) };
}

// Add the focused product+location+quantity to the cart.
// Draft may be "200" or "200 × 5" — times creates that many independent lines
// of qty each (not qty×times as a single amount).
async function commitLine(db: Db, request: ItemRequest, draft: string): Promise<RequestResult> {
  const parsed = parseQuantityRepeat(draft);
  if (!parsed.ok) return { notice: parsed.notice };
  const { qty, times } = parsed.value;

  if (request.lines.length + times > MAX_LINES) {
    const room = MAX_LINES - request.lines.length;
    return {
      notice:
        room <= 0
          ? `A request can hold at most ${MAX_LINES} items.`
          : `Only ${room} more entr${room === 1 ? "y" : "ies"} fit (max ${MAX_LINES}). Lower × entries.`,
    };
  }

  const hit = await focusedHit(db, request);
  if (!hit) return { notice: "That item is no longer available." };

  const moveCode = request.ui.moveTypeCode || undefined;
  const types = moveCode ? (await activeMovementTypes(db)).map(toMovementType) : [];
  const moveType = moveCode ? types.find((t) => t.code === moveCode) : undefined;
  const direction = moveType?.direction;
  const isTransfer = direction === "transfer" || moveCode === "warehouse-transfer";

  const fromLocationId = request.ui.moveFromLocationId || undefined;
  const toLocationId = request.ui.moveToLocationId || undefined;

  if (isTransfer) {
    if (!fromLocationId) return { notice: "Pick where the stock is currently." };
    if (!toLocationId) return { notice: "Pick where you want to move it." };
    if (fromLocationId === toLocationId) {
      return { notice: "Source and destination must be different." };
    }
  }

  const locationId =
    (isTransfer ? fromLocationId : undefined) ||
    request.ui.focusLocationId ||
    request.ui.moveLocationId ||
    request.ui.moveToLocationId;
  if (!locationId) return { notice: "Pick a storage location first." };

  const wf = moveCode ? await getSearchMoveWorkflow(db, request.chatId) : null;
  const moveNode =
    wf && moveCode
      ? Object.values(wf.nodes).find((n) => n.kind === "movement" && n.movementCode === moveCode)
      : null;
  const branchQuestions = moveNode && wf ? collectQuestions(wf, moveNode.id) : [];
  const stockEffect =
    resolveStockEffectFromAnswers(branchQuestions, request.ui.moveAnswers) ||
    (moveNode && wf ? resolveStockEffectFromBranch(wf, moveNode.id) : undefined);

  const receiving = isInboundMovement({
    stockEffect,
    movementDirection: direction,
    movementCode: moveCode,
  });

  const fromPath =
    (fromLocationId &&
      (hit.lines.find((l) => l.locationId === fromLocationId)?.locationPath ||
        (await locationPathById(db, fromLocationId)))) ||
    "";
  const toPath = toLocationId ? (await locationPathById(db, toLocationId)) || "" : "";

  const stockLine = hit.lines.find((l) => l.locationId === locationId);
  const locationPath =
    isTransfer && fromPath
      ? fromPath
      : stockLine?.locationPath || (await locationPathById(db, locationId)) || "(unknown location)";
  const unit = stockLine?.unit || hit.unit;
  const totalRequested = qty * times;

  // Transfer / outbound: validate source stock at cart time (existing architecture).
  if (!receiving) {
    const shortage = await findOutboundShortage(db, {
      productId: hit.productId,
      productName: hit.name,
      productNumber: hit.productNumber,
      locationId,
      locationPath,
      unit,
      qty: totalRequested,
      inbound: false,
    });
    if (shortage) {
      await persistOutboundShortage(db, request, shortage, "cart", {
        code: moveCode,
        name: moveType?.name,
      });
      note(
        request,
        request.requesterName || "Requester",
        `Out of stock: ${hit.name} — requested ${money(totalRequested)} ${unit}` +
          (times > 1 ? ` (${money(qty)} × ${times} entries)` : "") +
          `, available ${money(shortage.available)} at ${locationPath}.`
      );
      return {
        render: renderOutOfStock(request, shortage, moveType?.name),
        notice: "Out of stock — not enough available at that location.",
      };
    }
  }

  const answers =
    moveCode && request.ui.moveAnswers
      ? Object.entries(request.ui.moveAnswers).map(([qid, a]) => {
          const qNode = wf ? Object.values(wf.nodes).find((n) => n.question?.id === qid) : null;
          return {
            label: qNode?.question?.label || qNode?.label || "Answer",
            display: String(a.display),
          };
        })
      : undefined;

  const purchaseStatus = resolvePurchaseStatus(moveCode, answers);

  const snapshot = {
    movementCode: moveCode,
    movementName: moveType?.name,
    movementDirection: direction,
    vendorId: request.ui.moveVendorId || undefined,
    vendorName: request.ui.moveVendorName || undefined,
    plantId: request.ui.movePlantId || undefined,
    plantName: request.ui.movePlantName || undefined,
    departmentId: request.ui.moveDepartmentId || undefined,
    departmentName: request.ui.moveDepartmentName || undefined,
    reference: request.ui.moveReference?.trim() || undefined,
    answers,
    purchaseStatus,
    stockEffect,
    ...(isTransfer && fromLocationId && toLocationId
      ? {
          fromLocationId,
          fromLocationPath: fromPath || locationPath,
          toLocationId,
          toLocationPath: toPath || "(unknown location)",
        }
      : {}),
  };

  // Single line (200): keep merge-with-existing behaviour.
  // Multiple lines (200 × 5): always create independent cart lines — never merge.
  if (times === 1) {
    const existing = request.lines.find(
      (l) =>
        l.productId === hit.productId &&
        l.locationId === locationId &&
        (l.movementCode || undefined) === (snapshot.movementCode || undefined) &&
        (l.vendorId || undefined) === (snapshot.vendorId || undefined) &&
        (l.plantId || undefined) === (snapshot.plantId || undefined) &&
        (l.departmentId || undefined) === (snapshot.departmentId || undefined) &&
        (l.fromLocationId || undefined) === (snapshot.fromLocationId || undefined) &&
        (l.toLocationId || undefined) === (snapshot.toLocationId || undefined) &&
        (l.reference || undefined) === (snapshot.reference || undefined) &&
        (l.purchaseStatus || undefined) === (snapshot.purchaseStatus || undefined) &&
        (l.stockEffect || undefined) === (snapshot.stockEffect || undefined)
    );
    if (existing) {
      if (!receiving) {
        const shortage = await findOutboundShortage(db, {
          productId: hit.productId,
          productName: hit.name,
          productNumber: hit.productNumber,
          locationId,
          locationPath,
          unit,
          qty: existing.qty + qty,
          inbound: false,
        });
        if (shortage) {
          await persistOutboundShortage(db, request, shortage, "cart", {
            code: moveCode,
            name: moveType?.name,
          });
          note(
            request,
            request.requesterName || "Requester",
            `Out of stock (cart merge): ${hit.name} — need ${money(existing.qty + qty)} ${unit}, available ${money(shortage.available)}.`
          );
          return {
            render: renderOutOfStock(request, shortage, moveType?.name),
            notice: "Out of stock — not enough available at that location.",
          };
        }
      }
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
        locationId,
        locationPath,
        qty,
        unit,
        ...snapshot,
      });
    }
  } else {
    for (let i = 0; i < times; i++) {
      request.lines.push({
        lineId: nextLineId(request),
        productId: hit.productId,
        productName: hit.name,
        productNumber: hit.productNumber,
        category: hit.category,
        subcategory: hit.subcategory,
        attributes: hit.attributes,
        locationId,
        locationPath,
        qty,
        unit,
        ...snapshot,
      });
    }
  }

  const added = times;
  const summary = formatItemQtySummary(hit.name, qty, unit, times);
  const isPurchase = moveCode === "new-purchase";
  const isReturn = moveCode === "return-from-plant";
  const isMoveStock = isTransfer || moveCode === "warehouse-transfer";
  const vendorName = request.ui.moveVendorName || "";
  const plantName = request.ui.movePlantName || "";
  const movePath =
    isMoveStock && fromPath && toPath ? `\nFrom: ${esc(fromPath)}\nTo: ${esc(toPath)}` : "";
  const addedLabel =
    added === 1
      ? `✅ <b>Added to Cart</b>\n\n${esc(summary)}${
          isPurchase && vendorName ? `\nVendor: ${esc(vendorName)}` : ""
        }${isReturn && plantName ? `\nFrom Plant: ${esc(plantName)}` : ""}${movePath}`
      : isPurchase
        ? `✅ <b>Added ${added} purchase entries to your cart</b>\n\n${esc(summary)}\n<i>Each entry is ${esc(formatQtyUnit(qty, unit))}.</i>`
        : isReturn
          ? `✅ <b>Added ${added} return entries to your cart</b>\n\n${esc(summary)}\n<i>Each entry is ${esc(formatQtyUnit(qty, unit))}.</i>`
          : isMoveStock
            ? `✅ <b>Added ${added} stock-move entries to your cart</b>\n\n${esc(summary)}${movePath}\n<i>Each entry is ${esc(formatQtyUnit(qty, unit))}.</i>`
        : `✅ <b>Added ${added} entries to your cart</b>\n\n${esc(summary)}\n<i>Each entry is ${esc(formatQtyUnit(qty, unit))}.</i>`;

  // Back to a clear post-add screen — Add to Cart was the confirmation.
  request.ui.focusProductId = null;
  request.ui.focusLocationId = null;
  request.ui.qtyDraft = "";
  clearCategoryPath(request.ui);
  clearMoveUi(request.ui);

  return {
    render: {
      text: `${addedLabel}\n\nCart now has <b>${request.lines.length}</b> line${request.lines.length === 1 ? "" : "s"}.`,
      keyboard: [
        [{ text: "➕ Add Another Item", callback_data: "rq:again" }],
        [{ text: `🛒 View Cart (${request.lines.length})`, callback_data: "rq:cart" }],
        [{ text: "✖ Cancel", callback_data: "rq:cancel" }],
      ],
    },
  };
}

// Confirm a borrowing: post it, then say what is left on the shelf.
//
// This is the one search-group action that settles itself. Everything else
// builds a cart line and waits for an Inventory Manager, because everything
// else is a request. A borrow is not a request — the maintenance user is at the
// shelf with the item — so the confirmation IS the transaction, and the number
// it reports back has to be the balance after the write rather than the one the
// screen was built from.
async function commitBorrow(db: Db, request: ItemRequest, by: string): Promise<RequestResult> {
  const ui = request.ui;
  const parsed = parseQuantityRepeat(ui.moveQtyDraft || ui.qtyDraft || "");
  if (!parsed.ok) return { notice: parsed.notice };
  // `qty × entries` splits one amount into several cart lines. A borrowing is a
  // single handover of a single amount, so the total is what leaves the shelf.
  const qty = parsed.value.qty * parsed.value.times;

  const hit = await focusedHit(db, request);
  if (!hit) return { notice: "That item is no longer available." };

  const locationId = ui.moveLocationId || ui.focusLocationId;
  if (!locationId) return { notice: "Pick a storage location first." };
  const locationPath =
    hit.lines.find((l) => l.locationId === locationId)?.locationPath ||
    (await locationPathById(db, locationId)) ||
    "(unknown location)";
  const unit = hit.lines.find((l) => l.locationId === locationId)?.unit || hit.unit;

  const maintenanceUserName = ui.moveMaintenanceUserName || "";
  if (!maintenanceUserName) return { notice: "Pick the maintenance user first." };
  const self = ui.moveBorrowerSelf !== false;
  const borrowedByName = ui.moveBorrowerName || (self ? maintenanceUserName : "");
  if (!borrowedByName) return { notice: "Say who is borrowing it — Himself or Other." };

  const posted = await postBorrowing(db, {
    chatId: request.chatId,
    productId: hit.productId,
    productName: hit.name,
    productNumber: hit.productNumber,
    unit,
    locationId,
    locationPath,
    qty,
    maintenanceUserId: ui.moveMaintenanceUserId || "",
    maintenanceUserName,
    borrowedByName,
    borrowedBySelf: self,
    ...(self ? {} : { workerId: ui.moveBorrowerId || undefined }),
    recordedByUserId: request.requesterUserId,
    recordedByName: by,
    ...(request._id ? { requestId: String(request._id) } : {}),
  });

  if (!posted.ok) {
    note(request, by, `Borrow refused: ${hit.name} — ${posted.reason}`);
    return {
      render: {
        text: [
          `⚠️ <b>Can't borrow that</b>`,
          "",
          `Item: ${esc(hit.name)}`,
          `Location: ${esc(locationPath)}`,
          `Wanted: ${money(qty)} ${esc(unit)}`,
          ...(posted.available === undefined ? [] : [`Available: ${money(posted.available)} ${esc(unit)}`]),
          "",
          `<i>${esc(posted.reason)}</i>`,
        ].join("\n"),
        keyboard: [
          [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
          [{ text: "✖ Cancel", callback_data: "rq:cancel" }],
        ],
      },
      notice: posted.reason,
    };
  }

  note(
    request,
    by,
    `Borrowed ${money(qty)} ${unit} ${hit.name} from ${locationPath} — ${maintenanceUserName}` +
      (self ? "" : ` (taken by ${borrowedByName})`) +
      ` · ${posted.ticketNumber}`
  );

  clearCategoryPath(ui);
  clearMoveUi(ui);
  ui.query = "";
  ui.focusProductId = null;
  ui.focusLocationId = null;
  ui.qtyDraft = "";
  ui.intentLocationPicked = false;
  // The borrowing is its own record, so it must survive whatever happens to the
  // draft that hosted the conversation — including the requester cancelling it.
  await saveRequest(db, request);

  const text = [
    `✅ <b>Borrowing recorded</b> — <b>${esc(posted.ticketNumber)}</b>`,
    "",
    `<b>${esc(hit.name)}</b> — ${money(posted.qty)} ${esc(unit)}`,
    `📍 ${esc(locationPath)}`,
    "",
    `Maintenance User: <b>${esc(maintenanceUserName)}</b>`,
    `Borrowed by: <b>${esc(borrowedByName)}</b>${self ? " <i>(himself)</i>" : ""}`,
    "",
    `<b>Remaining stock</b>`,
    `📍 ${esc(locationPath)}: <b>${money(posted.remainingAtLocation)}</b> ${esc(unit)}`,
    `All locations: <b>${money(posted.remainingTotal)}</b> ${esc(unit)}`,
  ].join("\n");

  return {
    render: {
      text,
      keyboard: [
        [{ text: "🔧 Borrow Another Item", callback_data: "rq:again" }],
        ...(request.lines.length
          ? [[{ text: `🛒 View Cart (${request.lines.length})`, callback_data: "rq:cart" }]]
          : []),
        [{ text: "✖ Close", callback_data: "rq:cancel" }],
      ],
    },
  };
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
