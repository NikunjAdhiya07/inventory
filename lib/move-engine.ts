import type { Db } from "mongodb";
import { locationChildren, locationParentIds, locationPathById } from "./locations";
import { activeMovementTypes, recordStockMovement, toMovementType, type MovementType } from "./movements";
import { lookupProducts, type StockHit } from "./stock";
import { buttonRows, type InlineKeyboard } from "./telegram";
import type { ItemRequest, MoveStage } from "./request-types";

// Stock-movement conversation inside a search/request group.
//
// After the user picks an item, the product screen offers Record movement vs
// Request item. Choosing Record movement runs this module: Movement Master types
// as buttons, then only the fields that type needs, then review → ledger write.
// No slash command — the same typed search that opens a request opens this path.

export type MoveRender = { text: string; keyboard: InlineKeyboard };
export type MoveResult = { render?: MoveRender; notice?: string; switchToRequest?: boolean };

const PAGE_SIZE = 8;
const LOCATIONS_SHOWN = 8;

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function money(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function clearMoveUi(ui: ItemRequest["ui"]): void {
  ui.intent = null;
  ui.moveStage = null;
  ui.moveTypeCode = null;
  ui.moveLocationId = null;
  ui.moveFromLocationId = null;
  ui.moveToLocationId = null;
  ui.moveQtyDraft = "";
  ui.moveReference = "";
  ui.moveRemarks = "";
  ui.locCursor = null;
  ui.locStack = [];
}

export async function focusedProduct(db: Db, request: ItemRequest): Promise<StockHit | null> {
  if (!request.ui.focusProductId) return null;
  const hits = await lookupProducts(db, request.ui.query || "", 40);
  return hits.find((h) => h.productId === request.ui.focusProductId) ?? null;
}

async function loadManualTypes(db: Db): Promise<MovementType[]> {
  const docs = await activeMovementTypes(db);
  return docs
    .map(toMovementType)
    .filter((t) => !t.isSystem && t.status === "Active")
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

async function selectedType(db: Db, request: ItemRequest): Promise<MovementType | null> {
  const code = request.ui.moveTypeCode;
  if (!code) return null;
  const all = await loadManualTypes(db);
  return all.find((t) => t.code === code) ?? null;
}

function fieldChain(type: MovementType): MoveStage[] {
  const mid: MoveStage[] = type.direction === "transfer" ? ["from", "to", "qty"] : ["location", "qty"];
  if (type.requireReference) mid.push("reference");
  if (type.requireRemarks) mid.push("remarks");
  mid.push("review");
  return mid;
}

function nextAfter(stage: MoveStage, type: MovementType): MoveStage {
  const chain = fieldChain(type);
  const i = chain.indexOf(stage);
  if (i < 0) return chain[0];
  return chain[Math.min(i + 1, chain.length - 1)];
}

function prevBefore(stage: MoveStage, type: MovementType): MoveStage | "type" {
  const chain = fieldChain(type);
  const i = chain.indexOf(stage);
  if (i <= 0) return "type";
  return chain[i - 1];
}

function footer(request: ItemRequest): InlineKeyboard[number] {
  const row = [];
  if (request.lines.length) row.push({ text: `🧺 Cart (${request.lines.length})`, callback_data: "rq:cart" });
  row.push({ text: "✖ Cancel", callback_data: "rq:cancel" });
  return row;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export async function renderMoveFlow(db: Db, request: ItemRequest): Promise<MoveRender> {
  const stage = request.ui.moveStage;
  if (!stage || stage === "type") return renderTypePicker(db, request);
  if (stage === "done") return renderDone(db, request);
  if (stage === "review") return renderReview(db, request);
  if (stage === "qty") return renderQty(db, request);
  if (stage === "reference") return renderTextField(request, "reference");
  if (stage === "remarks") return renderTextField(request, "remarks");
  if (stage === "from") return renderStockLocations(db, request, "from");
  if (stage === "to" || stage === "location") {
    const type = await selectedType(db, request);
    if (stage === "location" && type?.direction === "out") return renderStockLocations(db, request, "location");
    return renderLocationTree(db, request, stage);
  }
  return renderTypePicker(db, request);
}

export async function renderProductIntent(db: Db, request: ItemRequest): Promise<MoveRender> {
  const hit = await focusedProduct(db, request);
  if (!hit) {
    return {
      text: "That product is no longer available. Search again.",
      keyboard: [[{ text: "✖ Cancel", callback_data: "rq:cancel" }]],
    };
  }

  const lines = [
    `<b>${esc(hit.name)}</b>${hit.productNumber ? ` · ${esc(hit.productNumber)}` : ""}`,
    `${money(hit.total)} ${esc(hit.unit)} on hand`,
    "",
  ];
  if (hit.lines.length) {
    for (const l of hit.lines.slice(0, LOCATIONS_SHOWN)) {
      lines.push(`📍 ${esc(l.locationPath)} — <b>${money(l.qty)}</b>`);
    }
    if (hit.lines.length > LOCATIONS_SHOWN) lines.push(`…and ${hit.lines.length - LOCATIONS_SHOWN} more`);
  } else {
    lines.push("<i>Nothing on the shelf yet — Opening Stock / Stock In can add it.</i>");
  }
  lines.push("", "What do you want to do?");

  const keyboard: InlineKeyboard = [
    [{ text: "⇄ Record movement", callback_data: "rq:mv:rec" }],
    ...(hit.total > 0 ? [[{ text: "🧺 Request item", callback_data: "rq:mv:req" }]] : []),
    [{ text: "⬅ Back", callback_data: "rq:back" }],
    footer(request),
  ];
  return { text: lines.join("\n"), keyboard };
}

async function renderTypePicker(db: Db, request: ItemRequest): Promise<MoveRender> {
  const hit = await focusedProduct(db, request);
  const types = await loadManualTypes(db);
  const name = hit ? esc(hit.name) : "Item";

  if (!types.length) {
    return {
      text: `<b>${name}</b>\n\nNo movement types are active. An admin can enable them under Movement Types.`,
      keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
    };
  }

  const groups: { title: string; direction: string }[] = [
    { title: "Stock In", direction: "in" },
    { title: "Stock Out", direction: "out" },
    { title: "Transfer", direction: "transfer" },
  ];

  const lines = [`<b>${name}</b>`, "Pick a stock movement:", ""];
  const btns: { text: string; callback_data: string }[] = [];
  let idx = 0;
  for (const g of groups) {
    const slice = types.filter((t) => t.direction === g.direction);
    if (!slice.length) continue;
    lines.push(`<b>${g.title}</b>`);
    for (const t of slice) {
      lines.push(`· ${esc(t.name)}`);
      btns.push({ text: truncate(t.name, 30), callback_data: `rq:mv:t:${idx}` });
      idx++;
    }
    lines.push("");
  }

  // Rebuild the same flat list the callbacks index into (Active, non-system, grouped).
  const indexed: MovementType[] = [];
  for (const g of groups) {
    for (const t of types.filter((x) => x.direction === g.direction)) indexed.push(t);
  }

  const page = Math.min(Math.max(request.ui.page ?? 0, 0), Math.max(0, Math.ceil(indexed.length / PAGE_SIZE) - 1));
  request.ui.page = page;
  const start = page * PAGE_SIZE;
  const slice = indexed.slice(start, start + PAGE_SIZE).map((t, i) => ({
    text: truncate(t.name, 30),
    callback_data: `rq:mv:t:${start + i}`,
  }));
  const rows = buttonRows(slice, 1);
  const pager: InlineKeyboard[number] = [];
  if (page > 0) pager.push({ text: "◀ Prev", callback_data: "rq:mv:pg:p" });
  if (start + PAGE_SIZE < indexed.length) pager.push({ text: "Next ▶", callback_data: "rq:mv:pg:n" });
  if (pager.length) rows.push(pager);
  rows.push([{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request));

  return { text: lines.join("\n").trim(), keyboard: rows };
}

async function renderStockLocations(db: Db, request: ItemRequest, which: "location" | "from"): Promise<MoveRender> {
  const hit = await focusedProduct(db, request);
  const type = await selectedType(db, request);
  if (!hit || !type) {
    return { text: "That movement is no longer available.", keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }]] };
  }

  const title = which === "from" ? "Where is it moving from?" : `Where to take stock from? (${esc(type.name)})`;
  const lines = [`<b>${esc(hit.name)}</b> — ${esc(type.name)}`, title, ""];

  if (!hit.lines.length) {
    return {
      text: lines.concat(["<i>No stock on hand at any location.</i>"]).join("\n"),
      keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
    };
  }

  const btns = hit.lines.slice(0, LOCATIONS_SHOWN).map((l, i) => ({
    text: `📍 ${truncate(l.locationPath, 26)} (${money(l.qty)})`,
    callback_data: `rq:mv:sl:${i}`,
  }));

  return {
    text: lines.join("\n"),
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
  };
}

async function renderLocationTree(db: Db, request: ItemRequest, stage: "location" | "to"): Promise<MoveRender> {
  const hit = await focusedProduct(db, request);
  const type = await selectedType(db, request);
  const cursor = request.ui.locCursor ?? null;
  const [children, parents, here] = await Promise.all([
    locationChildren(db, cursor),
    locationParentIds(db),
    cursor ? locationPathById(db, cursor) : Promise.resolve(""),
  ]);

  const heading = stage === "to" ? "Where is it moving to?" : `Where to put stock? (${esc(type?.name ?? "")})`;
  const lines = [`<b>${esc(hit?.name ?? "Item")}</b> — ${esc(type?.name ?? "")}`, heading];
  if (here) lines.push(`<i>Current: ${esc(here)}</i>`);
  lines.push("", "<i>Drill into the location, then confirm.</i>");

  const btns = children.map((c, i) => ({
    text: `${parents.has(c._id.toString()) ? "📁" : "📍"} ${truncate(String(c.name), 24)}`,
    callback_data: `rq:mv:loc:${i}`,
  }));
  const rows: InlineKeyboard = buttonRows(btns, 2);
  if (cursor) rows.push([{ text: "✔ Use this location", callback_data: "rq:mv:loc:sel" }]);
  rows.push([{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request));
  return { text: lines.join("\n"), keyboard: rows };
}

async function renderQty(db: Db, request: ItemRequest): Promise<MoveRender> {
  const hit = await focusedProduct(db, request);
  const type = await selectedType(db, request);
  if (!hit || !type) {
    return { text: "That movement is no longer available.", keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }]] };
  }

  let where = "";
  if (type.direction === "transfer") {
    const from = request.ui.moveFromLocationId ? await locationPathById(db, request.ui.moveFromLocationId) : "";
    const to = request.ui.moveToLocationId ? await locationPathById(db, request.ui.moveToLocationId) : "";
    where = `${esc(from)} → ${esc(to)}`;
  } else {
    const id = request.ui.moveLocationId;
    where = id ? esc(await locationPathById(db, id)) : "";
  }

  const draft = request.ui.moveQtyDraft ?? "";
  const text =
    `<b>${esc(hit.name)}</b> — ${esc(type.name)}\n` + `${where}\n\n` + `Qty: <b>${draft || "—"}</b> ${esc(hit.unit)}`;

  const key = (d: string) => ({ text: d, callback_data: `rq:mv:q:${d}` });
  const keyboard: InlineKeyboard = [
    ["1", "2", "3"].map(key),
    ["4", "5", "6"].map(key),
    ["7", "8", "9"].map(key),
    [key("."), key("0"), { text: "⌫", callback_data: "rq:mv:q:del" }],
    [{ text: "✔ Next", callback_data: "rq:mv:q:ok" }],
    [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
    footer(request),
  ];
  return { text, keyboard };
}

function renderTextField(request: ItemRequest, field: "reference" | "remarks"): MoveRender {
  const label = field === "reference" ? "reference (document / ticket number)" : "remarks";
  const current = field === "reference" ? request.ui.moveReference : request.ui.moveRemarks;
  const lines = [
    `<b>Type the ${label}</b>`,
    current ? `Current: <i>${esc(current)}</i>` : "<i>Send a message in this group with the answer.</i>",
  ];
  return {
    text: lines.join("\n"),
    keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
  };
}

async function renderReview(db: Db, request: ItemRequest): Promise<MoveRender> {
  const hit = await focusedProduct(db, request);
  const type = await selectedType(db, request);
  if (!hit || !type) {
    return { text: "That movement is no longer available.", keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }]] };
  }

  const qty = Number(request.ui.moveQtyDraft) || 0;
  const lines = [`<b>${esc(type.name)}</b>`, `${esc(hit.name)} × <b>${money(qty)}</b> ${esc(hit.unit)}`, ""];

  if (type.direction === "transfer") {
    const from = request.ui.moveFromLocationId ? await locationPathById(db, request.ui.moveFromLocationId) : "—";
    const to = request.ui.moveToLocationId ? await locationPathById(db, request.ui.moveToLocationId) : "—";
    lines.push(`From: ${esc(from)}`, `To: ${esc(to)}`);
  } else {
    const id = request.ui.moveLocationId;
    const path = id ? await locationPathById(db, id) : "—";
    lines.push(`${type.direction === "out" ? "From" : "At"}: ${esc(path)}`);
  }
  if (request.ui.moveReference) lines.push(`Ref: ${esc(request.ui.moveReference)}`);
  if (request.ui.moveRemarks) lines.push(`Remarks: ${esc(request.ui.moveRemarks)}`);
  lines.push("", "Confirm to update inventory.");

  return {
    text: lines.join("\n"),
    keyboard: [
      [{ text: "✅ Confirm", callback_data: "rq:mv:ok" }],
      [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
      [{ text: "✖ Cancel", callback_data: "rq:cancel" }],
    ],
  };
}

async function renderDone(db: Db, request: ItemRequest): Promise<MoveRender> {
  const hit = await focusedProduct(db, request);
  const summary = request.ui.moveRemarks || "Movement saved.";
  const lines = [`✅ <b>Recorded</b>${hit ? ` — ${esc(hit.name)}` : ""}`, "", ...summary.split("\n").map((l) => esc(l))];
  return {
    text: lines.join("\n"),
    keyboard: [
      [{ text: "🔍 Search again", callback_data: "rq:mv:again" }],
      ...(request.lines.length ? [[{ text: `🧺 Cart (${request.lines.length})`, callback_data: "rq:cart" }]] : []),
      [{ text: "✖ Close", callback_data: "rq:cancel" }],
    ],
  };
}

// ---------------------------------------------------------------------------
// Callbacks & typed answers
// ---------------------------------------------------------------------------

export async function applyMoveCallback(db: Db, request: ItemRequest, data: string, by: string): Promise<MoveResult> {
  const ui = request.ui;

  if (data === "rq:mv:rec") {
    ui.intent = "move";
    ui.moveStage = "type";
    ui.moveTypeCode = null;
    ui.moveLocationId = null;
    ui.moveFromLocationId = null;
    ui.moveToLocationId = null;
    ui.moveQtyDraft = "";
    ui.moveReference = "";
    ui.moveRemarks = "";
    ui.locCursor = null;
    ui.locStack = [];
    ui.page = 0;
    return { render: await renderMoveFlow(db, request) };
  }

  if (data === "rq:mv:req") {
    const hit = await focusedProduct(db, request);
    if (!hit || hit.total <= 0) return { notice: "Nothing on hand to request." };
    clearMoveUi(ui);
    ui.intent = "request";
    ui.focusProductId = hit.productId;
    ui.focusLocationId = null;
    ui.qtyDraft = "";
    return { switchToRequest: true };
  }

  if (data === "rq:mv:again") {
    clearMoveUi(ui);
    ui.query = "";
    ui.focusProductId = null;
    ui.focusLocationId = null;
    ui.page = 0;
    return { render: { text: `<b>Search stock</b>\nType a product name to request items or record a movement.`, keyboard: [footer(request)] } };
  }

  if (data === "rq:mv:back") return applyMoveBack(db, request);

  if (data.startsWith("rq:mv:pg:")) {
    ui.page = Math.max(0, (ui.page ?? 0) + (data === "rq:mv:pg:n" ? 1 : -1));
    return { render: await renderMoveFlow(db, request) };
  }

  if (data.startsWith("rq:mv:t:")) {
    const types = await loadManualTypes(db);
    // Same grouping order as the picker so the index matches the button.
    const indexed: MovementType[] = [];
    for (const d of ["in", "out", "transfer"] as const) {
      for (const t of types.filter((x) => x.direction === d)) indexed.push(t);
    }
    const t = indexed[Number(data.slice("rq:mv:t:".length))];
    if (!t) return { notice: "That movement type is no longer available." };
    ui.moveTypeCode = t.code;
    ui.moveLocationId = null;
    ui.moveFromLocationId = null;
    ui.moveToLocationId = null;
    ui.moveQtyDraft = "";
    ui.moveReference = "";
    ui.moveRemarks = "";
    ui.locCursor = null;
    ui.locStack = [];
    ui.moveStage = t.direction === "transfer" ? "from" : "location";
    return { render: await renderMoveFlow(db, request) };
  }

  if (data.startsWith("rq:mv:sl:")) {
    const hit = await focusedProduct(db, request);
    const line = hit?.lines[Number(data.slice("rq:mv:sl:".length))];
    if (!line) return { notice: "That location is no longer available." };
    const type = await selectedType(db, request);
    if (!type) return { notice: "Pick a movement type first." };
    if (ui.moveStage === "from") {
      ui.moveFromLocationId = line.locationId;
      ui.moveStage = "to";
      ui.locCursor = null;
      ui.locStack = [];
    } else {
      ui.moveLocationId = line.locationId;
      ui.moveStage = nextAfter("location", type);
    }
    return { render: await renderMoveFlow(db, request) };
  }

  if (data.startsWith("rq:mv:loc:")) {
    const res = await applyMoveLocationPick(db, request, data);
    if (res.notice) return { notice: res.notice };
    if (res.chosen) {
      const type = await selectedType(db, request);
      if (!type) return { notice: "Pick a movement type first." };
      if (ui.moveStage === "to") {
        ui.moveToLocationId = res.chosen;
        ui.moveStage = nextAfter("to", type);
      } else {
        ui.moveLocationId = res.chosen;
        ui.moveStage = nextAfter("location", type);
      }
      ui.locCursor = null;
      ui.locStack = [];
    }
    return { render: await renderMoveFlow(db, request) };
  }

  if (data.startsWith("rq:mv:q:")) return applyMoveQtyKey(db, request, data.slice("rq:mv:q:".length));

  if (data === "rq:mv:ok") return commitMove(db, request, by);

  return { notice: "Use the buttons above." };
}

async function applyMoveLocationPick(
  db: Db,
  request: ItemRequest,
  data: string
): Promise<{ chosen?: string; notice?: string }> {
  const ui = request.ui;
  const cursor = ui.locCursor ?? null;

  if (data === "rq:mv:loc:sel") {
    if (!cursor) return { notice: "Drill into a location first." };
    return { chosen: cursor };
  }

  const children = await locationChildren(db, cursor);
  const chosen = children[Number(data.slice("rq:mv:loc:".length))];
  if (!chosen) return { notice: "That location is no longer available." };

  const chosenId = chosen._id.toString();
  const parents = await locationParentIds(db);
  if (!parents.has(chosenId)) return { chosen: chosenId };

  if (cursor) (ui.locStack ??= []).push(cursor);
  ui.locCursor = chosenId;
  return {};
}

async function applyMoveQtyKey(db: Db, request: ItemRequest, pressed: string): Promise<MoveResult> {
  const ui = request.ui;
  let draft = ui.moveQtyDraft ?? "";
  const type = await selectedType(db, request);
  if (!type) return { notice: "Pick a movement type first." };

  if (pressed === "ok") {
    const qty = Number(draft);
    if (!draft || !Number.isFinite(qty) || qty <= 0) return { notice: "Enter a quantity first." };
    ui.moveStage = nextAfter("qty", type);
    return { render: await renderMoveFlow(db, request) };
  }

  if (pressed === "del") draft = draft.slice(0, -1);
  else if (pressed === ".") {
    if (draft.includes(".")) return { notice: "Only one decimal point." };
    draft = draft === "" ? "0." : `${draft}.`;
  } else {
    if (draft.replace(".", "").length >= 9) return { notice: "That's as large as a quantity can get." };
    draft = draft === "0" ? pressed : draft + pressed;
  }
  ui.moveQtyDraft = draft;
  return { render: await renderMoveFlow(db, request) };
}

async function applyMoveBack(db: Db, request: ItemRequest): Promise<MoveResult> {
  const ui = request.ui;
  const stage = ui.moveStage;

  if (!stage || stage === "type") {
    clearMoveUi(ui);
    return { render: await renderProductIntent(db, request) };
  }

  if (stage === "done") {
    clearMoveUi(ui);
    ui.query = "";
    ui.focusProductId = null;
    return { render: { text: `<b>Search stock</b>\nType a product name to request items or record a movement.`, keyboard: [footer(request)] } };
  }

  if ((stage === "location" || stage === "to") && ui.locStack?.length) {
    ui.locCursor = ui.locStack.pop() ?? null;
    return { render: await renderMoveFlow(db, request) };
  }
  if ((stage === "location" || stage === "to") && ui.locCursor) {
    ui.locCursor = null;
    return { render: await renderMoveFlow(db, request) };
  }

  const type = await selectedType(db, request);
  if (!type) {
    ui.moveStage = "type";
    return { render: await renderMoveFlow(db, request) };
  }

  const prev = prevBefore(stage, type);
  if (prev === "type") {
    ui.moveStage = "type";
    ui.moveTypeCode = null;
  } else {
    ui.moveStage = prev;
  }
  return { render: await renderMoveFlow(db, request) };
}

export async function applyMoveMessage(db: Db, request: ItemRequest, text: string): Promise<MoveResult | null> {
  const stage = request.ui.moveStage;
  if (request.ui.intent !== "move") return null;
  if (stage !== "reference" && stage !== "remarks") return null;

  const type = await selectedType(db, request);
  if (!type) return { notice: "Pick a movement type first." };

  if (stage === "reference") {
    request.ui.moveReference = text.slice(0, 120);
    request.ui.moveStage = nextAfter("reference", type);
    return { render: await renderMoveFlow(db, request) };
  }

  request.ui.moveRemarks = text.slice(0, 400);
  request.ui.moveStage = nextAfter("remarks", type);
  return { render: await renderMoveFlow(db, request) };
}

async function commitMove(db: Db, request: ItemRequest, by: string): Promise<MoveResult> {
  const hit = await focusedProduct(db, request);
  const type = await selectedType(db, request);
  if (!hit || !type) return { notice: "That movement is no longer available." };

  const qty = Number(request.ui.moveQtyDraft);
  const result = await recordStockMovement(db, {
    typeCode: type.code,
    productId: hit.productId,
    qty,
    locationId: request.ui.moveLocationId || undefined,
    fromLocationId: request.ui.moveFromLocationId || undefined,
    toLocationId: request.ui.moveToLocationId || undefined,
    remarks: request.ui.moveRemarks || undefined,
    reference: request.ui.moveReference || undefined,
    by,
  });

  if (!result.ok) return { notice: result.error };

  const bal = result.balances.map((b) => `${b.locationPath}: ${money(b.qty)}`).join("\n");
  request.ui.moveStage = "done";
  // Plain-text confirmation; renderDone escapes it for Telegram HTML.
  request.ui.moveRemarks =
    `${type.name} · ${money(result.qty)} ${hit.unit}` + (bal ? `\n\nOn hand now:\n${bal}` : "");

  return { render: await renderMoveFlow(db, request) };
}

export function isMoveCallback(data: string): boolean {
  return data.startsWith("rq:mv:");
}
