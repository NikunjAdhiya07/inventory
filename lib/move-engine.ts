import type { Db } from "mongodb";
import { categoryChildNames } from "./categories";
import { locationChildren, locationParentIds, locationPathById } from "./locations";
import { activeMovementTypes, toMovementType, type MovementType } from "./movements";
import type { MoveQuestion } from "./movement-questions";
import {
  applyMessageTemplate,
  collectQuestions,
  enterMovementBranch,
  getSearchMoveWorkflow,
  leadInHasKind,
  leadInNode,
  movementBranches,
  movementCodesInTree,
  nextNodeId,
  nodeAfterDiscovery,
  prevNodeId,
  resolveStockEffectFromBranch,
  type FlowNode,
  type SearchMoveWorkflow,
} from "./search-move-workflow";
import { resolveStockEffectFromAnswers } from "./movement-questions";
import { lookupProducts, type StockHit } from "./stock";
import { buttonRows, type InlineKeyboard } from "./telegram";
import type { ItemRequest } from "./request-types";
import { activeVendors } from "./vendors";
import { activeDepartments } from "./departments";
import { findOutboundShortage, isInboundMovement, persistOutboundShortage } from "./outbound-stock";
import { note } from "./requests";

// Tree-driven movement conversation for the search group.
// Telegram walks the same Workflows flowchart the admin edits — lead-in and
// per-movement branches, using each node's label + Telegram message.

export type MoveRender = { text: string; keyboard: InlineKeyboard };
export type MoveResult = {
  render?: MoveRender;
  notice?: string;
  /** Signal request-engine to commit the cart line from collected flow fields. */
  addToCart?: boolean;
};

const PAGE_SIZE = 6;
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
  ui.flowNodeId = null;
  ui.moveTypeCode = null;
  ui.moveLocationId = null;
  ui.moveFromLocationId = null;
  ui.moveToLocationId = null;
  ui.moveVendorId = null;
  ui.moveVendorName = null;
  ui.moveDepartmentId = null;
  ui.moveDepartmentName = null;
  ui.moveQtyDraft = "";
  ui.moveReference = "";
  ui.moveRemarks = "";
  ui.moveQuestionIndex = 0;
  ui.moveAnswers = {};
  ui.moveNumberDraft = "";
  ui.locCursor = null;
  ui.locStack = [];
}

export async function focusedProduct(db: Db, request: ItemRequest): Promise<StockHit | null> {
  if (!request.ui.focusProductId) return null;
  const hits = await lookupProducts(db, request.ui.query || "", 40);
  return hits.find((h) => h.productId === request.ui.focusProductId) ?? null;
}

async function loadWorkflow(db: Db): Promise<SearchMoveWorkflow> {
  return getSearchMoveWorkflow(db);
}

async function loadManualTypes(db: Db): Promise<MovementType[]> {
  const docs = await activeMovementTypes(db);
  const all = docs
    .map(toMovementType)
    .filter((t) => !t.isSystem && t.status === "Active");
  const wf = await loadWorkflow(db);
  const codes = movementCodesInTree(wf);
  if (!codes.length) {
    return all.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }
  const byCode = new Map(all.map((t) => [t.code, t]));
  return codes.map((c) => byCode.get(c)).filter((t): t is MovementType => Boolean(t));
}

function footer(request: ItemRequest): InlineKeyboard[number] {
  const row = [];
  if (request.lines.length) row.push({ text: `🧺 Cart (${request.lines.length})`, callback_data: "rq:cart" });
  row.push({ text: "✖ Cancel", callback_data: "rq:cancel" });
  return row;
}

function currentNode(wf: SearchMoveWorkflow, request: ItemRequest): FlowNode | null {
  const id = request.ui.flowNodeId;
  if (!id) return null;
  return wf.nodes[id] ?? null;
}

async function promptVars(db: Db, request: ItemRequest, hit: StockHit | null, type: MovementType | null): Promise<Record<string, string>> {
  const locId = request.ui.moveLocationId || request.ui.focusLocationId;
  const where = locId ? await locationPathById(db, locId) : "";
  const stockLines =
    hit?.lines
      .slice(0, 6)
      .map((l) => `📍 ${l.locationPath} — ${money(l.qty)}`)
      .join("\n") || "";
  const path = categoryPathOf(request.ui);
  const tip = path[path.length - 1] || request.ui.focusCategory || "";
  const children = tip ? (await categoryChildNames(db, tip)).join(", ") : "";
  return {
    product: hit ? `${hit.name}${hit.category ? ` · ${hit.category}` : ""}` : request.ui.query || "",
    type: type?.name ?? "",
    unit: hit?.unit ?? "",
    qty: request.ui.moveQtyDraft || "—",
    where: where || "—",
    stock_lines: stockLines,
    children,
    vendor: request.ui.moveVendorName || "",
    department: request.ui.moveDepartmentName || "",
    question: "",
  };
}

function nodeText(node: FlowNode, vars: Record<string, string>): string {
  return applyMessageTemplate(node.message || node.label, vars).replace(/\n{3,}/g, "\n\n").trim();
}

function uniqueCategories(hits: StockHit[]): string[] {
  const set = new Set<string>();
  for (const h of hits) set.add(String(h.category ?? "").trim() || "Other");
  return [...set].sort((a, b) => a.localeCompare(b));
}

function subcategoryLabel(raw: unknown): string {
  const s = String(raw ?? "").trim();
  return s || "(none)";
}

function uniqueSubcategories(hits: StockHit[]): string[] {
  const set = new Set<string>();
  for (const h of hits) set.add(subcategoryLabel(h.subcategory));
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Category trail on the draft UI (names from the chosen match down). */
export function categoryPathOf(ui: ItemRequest["ui"]): string[] {
  if (ui.categoryPath?.length) return ui.categoryPath.map(String).filter(Boolean);
  const path: string[] = [];
  if (ui.focusCategory) path.push(ui.focusCategory);
  if (ui.focusSubcategory) path.push(ui.focusSubcategory);
  return path;
}

/** Keep focusCategory / focusSubcategory aligned with the trail for older code paths. */
export function setCategoryPath(ui: ItemRequest["ui"], path: string[]): void {
  const clean = path.map((p) => String(p ?? "").trim()).filter(Boolean);
  ui.categoryPath = clean;
  ui.focusCategory = clean[0] ?? null;
  ui.focusSubcategory = clean.length >= 2 ? clean[1] : null;
}

export function clearCategoryPath(ui: ItemRequest["ui"]): void {
  ui.categoryPath = [];
  ui.focusCategory = null;
  ui.focusSubcategory = null;
}

/**
 * Next-level options under the tip of `path`: every direct child in the
 * Categories tree. At the first level after a product-category pick, falls back
 * to distinct product.subcategory values when the tree has no children.
 */
export async function resolveCategoryChildren(
  db: Db,
  path: string[],
  hitsInRootCategory: StockHit[] = []
): Promise<string[]> {
  if (!path.length) return [];
  const tip = path[path.length - 1];
  const fromTree = await categoryChildNames(db, tip);
  if (fromTree.length) return fromTree;
  // Only the first drill (root category → its children) may use product strings.
  if (path.length === 1) return uniqueSubcategories(hitsInRootCategory);
  return [];
}

/** @deprecated — use resolveCategoryChildren */
export async function resolveSubcategoryOptions(
  db: Db,
  parentCategory: string,
  hitsInCategory: StockHit[] = []
): Promise<string[]> {
  return resolveCategoryChildren(db, [parentCategory], hitsInCategory);
}

function hitMatchesCategoryPath(hit: StockHit, path: string[]): boolean {
  if (!path.length) return true;
  const cat = String(hit.category ?? "").trim() || "Other";
  if (cat !== path[0]) return false;
  if (path.length === 1) return true;
  const sub = String(hit.subcategory ?? "").trim();
  if (!sub) return false;
  // Products store two levels; deeper trail still keys off level-2 (subcategory).
  return sub === path[1];
}

function filterSearchHits(raw: StockHit[], ui: ItemRequest["ui"]): StockHit[] {
  const path = categoryPathOf(ui);
  if (path.length) return raw.filter((h) => hitMatchesCategoryPath(h, path));
  let hits = raw;
  if (ui.focusCategory) {
    hits = hits.filter((h) => (String(h.category ?? "").trim() || "Other") === ui.focusCategory);
  }
  if (ui.focusSubcategory) {
    hits = hits.filter((h) => subcategoryLabel(h.subcategory) === ui.focusSubcategory);
  }
  return hits;
}

/** Start (or restart) the flowchart from its root when the user types a search. */
export async function startSearchFlow(db: Db, request: ItemRequest, query: string): Promise<MoveRender> {
  const wf = await loadWorkflow(db);
  request.ui.query = query.slice(0, 60);
  request.ui.page = 0;
  request.ui.focusProductId = null;
  request.ui.focusLocationId = null;
  clearCategoryPath(request.ui);
  request.ui.intentLocationPicked = false;
  request.ui.qtyDraft = "";
  clearMoveUi(request.ui);
  request.ui.flowNodeId = wf.rootId;
  request.ui.intent = "move";
  request.ui.moveStage = "type";
  return renderMoveFlow(db, request);
}

/** After an item is chosen, jump to the first post-discovery lead-in node. */
export async function continueAfterProductPick(db: Db, request: ItemRequest): Promise<MoveRender> {
  const wf = await loadWorkflow(db);
  const next = nodeAfterDiscovery(wf) ?? wf.rootId;
  request.ui.flowNodeId = next;
  request.ui.intent = "move";
  request.ui.moveStage = "type";
  return renderMoveFlow(db, request);
}

/** @deprecated — prefer startSearchFlow / continueAfterProductPick */
export async function startConfiguredFlow(db: Db, request: ItemRequest): Promise<MoveRender> {
  if (request.ui.focusProductId) return continueAfterProductPick(db, request);
  const wf = await loadWorkflow(db);
  request.ui.flowNodeId = wf.rootId;
  request.ui.intent = "move";
  request.ui.moveStage = "type";
  return renderMoveFlow(db, request);
}

/** @deprecated intent screen removed */
export async function renderProductIntent(db: Db, request: ItemRequest): Promise<MoveRender> {
  return startConfiguredFlow(db, request);
}

export async function renderMoveFlow(db: Db, request: ItemRequest): Promise<MoveRender> {
  const wf = await loadWorkflow(db);
  if (!request.ui.flowNodeId) {
    request.ui.flowNodeId = wf.rootId;
  }
  const node = currentNode(wf, request);
  if (!node) {
    request.ui.flowNodeId = wf.rootId;
    return renderMoveFlow(db, request);
  }

  const hit = await focusedProduct(db, request);
  const type = request.ui.moveTypeCode
    ? (await loadManualTypes(db)).find((t) => t.code === request.ui.moveTypeCode) ?? null
    : null;
  const vars = await promptVars(db, request, hit, type);

  switch (node.kind) {
    case "search":
      return renderSearchNode(db, request, wf, node, vars);
    case "pick_category":
      return renderCategoryNode(db, request, node, vars);
    case "pick_product":
      // Legacy — treat as search results
      return renderSearchNode(db, request, wf, node, vars);
    case "movement": {
      const first = node.children[0];
      if (first) {
        request.ui.flowNodeId = first;
        return renderMoveFlow(db, request);
      }
      return {
        text: nodeText(node, vars),
        keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
      };
    }
    case "pick_location":
    case "location":
      return renderLocationPick(db, request, node, hit, vars, "location");
    case "from":
      return renderLocationPick(db, request, node, hit, vars, "from");
    case "to":
      return renderLocationPick(db, request, node, hit, vars, "to");
    case "pick_vendor":
      return renderVendorPick(db, request, node, vars);
    case "pick_department":
      return renderDepartmentPick(db, request, node, vars);
    case "select_movement":
    case "record_hub":
      return renderSelectMovement(db, request, node, vars);
    case "qty":
      return renderQty(request, node, vars);
    case "stock_in":
    case "stock_out": {
      // Silent Accept-sign markers — never shown in Telegram.
      const skipTo = node.children[0];
      if (skipTo) {
        request.ui.flowNodeId = skipTo;
        return renderMoveFlow(db, request);
      }
      return {
        text: nodeText(node, vars) || node.label,
        keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
      };
    }
    case "question":
      return renderQuestion(request, node, vars);
    case "reference":
    case "remarks":
      return renderTextCapture(request, node, vars, type);
    case "review":
      return renderReview(db, request, node, hit, type, vars);
    case "add_to_cart":
    case "done":
      return renderAddToCart(db, request, node, hit, type, vars);
    default:
      return {
        text: nodeText(node, vars) || node.label,
        keyboard: [
          [{ text: "✔ Next", callback_data: "rq:mv:next" }],
          [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
          footer(request),
        ],
      };
  }
}

async function renderSearchNode(
  db: Db,
  request: ItemRequest,
  wf: SearchMoveWorkflow,
  node: FlowNode,
  vars: Record<string, string>
): Promise<MoveRender> {
  const ui = request.ui;
  if (!ui.query) {
    return {
      text: nodeText(node, vars) || "Type an item name to search stock.",
      keyboard: [footer(request)],
    };
  }

  // If the flowchart includes Pick category, walk the full Categories tree
  // (category → child → … → leaf) before listing items.
  if (leadInHasKind(wf, "pick_category")) {
    const hits = await lookupProducts(db, ui.query);
    const categories = uniqueCategories(hits);
    const path = categoryPathOf(ui);

    if (categories.length > 1 && !path.length) {
      const catNode = leadInNode(wf, "pick_category");
      request.ui.flowNodeId = catNode?.id ?? request.ui.flowNodeId;
      return renderCategoryNode(db, request, catNode ?? node, vars);
    }

    if (!path.length && categories.length === 1) {
      setCategoryPath(ui, [categories[0]]);
    }

    const effectivePath = categoryPathOf(ui);
    if (effectivePath.length) {
      const rootHits = hits.filter((h) => (String(h.category ?? "").trim() || "Other") === effectivePath[0]);
      const kids = await resolveCategoryChildren(db, effectivePath, rootHits);
      if (kids.length > 0) {
        // Auto-descend a single child so the user isn't stopped on a one-option level.
        if (kids.length === 1 && effectivePath.length < 20) {
          setCategoryPath(ui, [...effectivePath, kids[0]]);
          return renderSearchNode(db, request, wf, node, vars);
        }
        if (kids.length > 1) {
          const catNode = leadInNode(wf, "pick_category");
          if (catNode) request.ui.flowNodeId = catNode.id;
          return renderCategoryDrillNode(request, catNode ?? node, vars, kids);
        }
      }
    }
  }

  return renderProductResults(db, request, node, vars);
}

async function renderCategoryNode(
  db: Db,
  request: ItemRequest,
  node: FlowNode,
  vars: Record<string, string>
): Promise<MoveRender> {
  const hits = await lookupProducts(db, request.ui.query || "");
  const categories = uniqueCategories(hits);
  const path = categoryPathOf(request.ui);

  if (path.length) {
    const rootHits = hits.filter((h) => (String(h.category ?? "").trim() || "Other") === path[0]);
    const kids = await resolveCategoryChildren(db, path, rootHits);
    if (kids.length > 1) {
      return renderCategoryDrillNode(request, node, vars, kids);
    }
    if (kids.length === 1 && path.length < 20) {
      setCategoryPath(request.ui, [...path, kids[0]]);
      return renderCategoryNode(db, request, node, vars);
    }
    // Leaf reached — show items using search messaging.
    const wf = await loadWorkflow(db);
    const search = leadInNode(wf, "search") ?? node;
    return renderProductResults(db, request, search, vars);
  }

  if (categories.length <= 1) {
    if (categories[0]) setCategoryPath(request.ui, [categories[0]]);
    const wf = await loadWorkflow(db);
    const search = leadInNode(wf, "search") ?? node;
    return renderSearchNode(db, request, wf, search, vars);
  }

  const prompt = nodeText(node, { ...vars, product: request.ui.query || "" });
  const btns = categories.map((c, i) => ({
    text: truncate(c, 30),
    callback_data: `rq:cat:${i}`,
  }));
  return {
    text: `${prompt}\n\n<b>${categories.length} categories</b>`,
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:back" }], footer(request)],
  };
}

/** One level of the Categories tree under the current path tip. */
function renderCategoryDrillNode(
  request: ItemRequest,
  node: FlowNode,
  vars: Record<string, string>,
  children: string[]
): MoveRender {
  const path = categoryPathOf(request.ui);
  const scope = path.join(" › ") || "Category";
  const childVars = {
    ...vars,
    children: children.join(", "),
    product: request.ui.query || vars.product,
  };
  // Prefer the node's message when it references children / product; otherwise a clean drill prompt.
  const rawPrompt = nodeText(node, childVars);
  const prompt =
    rawPrompt && (node.message.includes("{{children}}") || path.length === 0)
      ? rawPrompt
      : `${esc(request.ui.query || "Search")}`;
  const btns = children.map((s, i) => ({
    text: truncate(s, 30),
    callback_data: `rq:sub:${i}`,
  }));
  const levelWord =
    path.length <= 1
      ? children.length === 1
        ? "subcategory"
        : "subcategories"
      : children.length === 1
        ? "option"
        : "options";
  return {
    text: `${prompt}\n\n<b>${esc(scope)}</b>\n<b>${children.length} ${levelWord}</b>\n\nPick next:`,
    keyboard: [
      ...buttonRows(btns, 1),
      [{ text: "⬅ Back", callback_data: "rq:back" }],
      footer(request),
    ],
  };
}

async function renderProductResults(
  db: Db,
  request: ItemRequest,
  node: FlowNode,
  vars: Record<string, string>
): Promise<MoveRender> {
  const ui = request.ui;
  const raw = await lookupProducts(db, ui.query || "");
  const hits = filterSearchHits(raw, ui);
  const path = categoryPathOf(ui);
  const scopeLabel = path.join(" › ");
  const header = nodeText(node, { ...vars, product: ui.query || "" });

  if (!hits.length) {
    return {
      text: `${header}\n\n${
        scopeLabel
          ? `No items in “${esc(scopeLabel)}” for “${esc(ui.query)}”.`
          : `No items for “${esc(ui.query)}”. Try another name.`
      }`,
      keyboard: [
        ...(path.length ? [[{ text: "⬅ Back", callback_data: "rq:back" }]] : []),
        footer(request),
      ],
    };
  }

  const pageCount = Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
  const page = Math.min(Math.max(ui.page ?? 0, 0), pageCount - 1);
  ui.page = page;
  const start = page * PAGE_SIZE;
  const slice = hits.slice(start, start + PAGE_SIZE);

  const lines = [
    header,
    "",
    scopeLabel
      ? `<b>${hits.length}</b> in “${esc(scopeLabel)}”`
      : `<b>${hits.length}</b> match${hits.length === 1 ? "" : "es"}`,
    "Pick an item:",
    "",
  ];
  for (const [i, hit] of slice.entries()) {
    const sub = hit.subcategory ? ` · ${esc(hit.subcategory)}` : "";
    const cat = !path.length && hit.category ? ` · ${esc(hit.category)}` : "";
    lines.push(`<b>${start + i + 1}. ${esc(hit.name)}</b>${cat}${sub} — ${money(hit.total)} ${esc(hit.unit)}`);
  }

  const btns = slice.map((_, i) => ({
    text: `${start + i + 1}. ${truncate(slice[i].name, 28)}`,
    callback_data: `rq:s:${start + i}`,
  }));
  const rows: InlineKeyboard = buttonRows(btns, 1);
  const pager = [];
  if (page > 0) pager.push({ text: "◀ Prev", callback_data: "rq:pg:p" });
  if (page < pageCount - 1) pager.push({ text: "Next ▶", callback_data: "rq:pg:n" });
  if (pager.length) rows.push(pager);
  if (path.length) rows.push([{ text: "⬅ Back", callback_data: "rq:back" }]);
  rows.push(footer(request));

  return { text: lines.join("\n"), keyboard: rows };
}

async function renderSelectMovement(
  db: Db,
  request: ItemRequest,
  node: FlowNode,
  vars: Record<string, string>
): Promise<MoveRender> {
  const wf = await loadWorkflow(db);
  const branches = movementBranches(wf);
  const all = await loadManualTypes(db);
  const byCode = new Map(all.map((t) => [t.code, t]));

  const types: MovementType[] = branches.length
    ? branches.map((b) => byCode.get(b.movementCode || "")).filter((t): t is MovementType => Boolean(t))
    : all;

  const btns = types.map((t, i) => ({
    text: truncate(t.name, 32),
    callback_data: `rq:mv:t:${i}`,
  }));

  return {
    text: nodeText(node, vars),
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
  };
}

async function renderLocationPick(
  db: Db,
  request: ItemRequest,
  node: FlowNode,
  hit: StockHit | null,
  vars: Record<string, string>,
  mode: "location" | "from" | "to"
): Promise<MoveRender> {
  const type = request.ui.moveTypeCode
    ? (await loadManualTypes(db)).find((t) => t.code === request.ui.moveTypeCode) ?? null
    : null;
  // Stock-out: offer shelves that already hold the item. Stock-in (return): browse
  // the full location tree so material can land anywhere, including empty bins.
  const receiving = type?.direction === "in" || mode === "to";
  if (hit && hit.lines.length && !receiving) {
    const btns = hit.lines.slice(0, LOCATIONS_SHOWN).map((l, i) => ({
      text: `📍 ${truncate(l.locationPath, 28)} (${money(l.qty)})`,
      callback_data: `rq:mv:sl:${i}`,
    }));
    return {
      text: nodeText(node, vars),
      keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
    };
  }

  const parentIds = await locationParentIds(db);
  const cursor = request.ui.locCursor ?? null;
  const kids = await locationChildren(db, cursor);
  const btns = kids.slice(0, LOCATIONS_SHOWN).map((l, i) => {
    const hasKids = parentIds.has(l.id);
    return {
      text: `${hasKids ? "▸ " : "📍 "}${truncate(l.name, 28)}`,
      callback_data: hasKids ? `rq:mv:loc:${i}` : `rq:mv:sel:${i}`,
    };
  });
  const nav: InlineKeyboard = [];
  if (cursor) nav.push([{ text: "⬆ Up", callback_data: "rq:mv:up" }]);
  nav.push([{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request));

  return {
    text: nodeText(node, vars),
    keyboard: [...buttonRows(btns, 1), ...nav],
  };
}

async function renderVendorPick(
  db: Db,
  request: ItemRequest,
  node: FlowNode,
  vars: Record<string, string>
): Promise<MoveRender> {
  const vendors = await activeVendors(db);
  if (!vendors.length) {
    return {
      text: `${nodeText(node, vars)}\n\n<i>No Active vendors in Vendor Master. Add vendors in the console, then try again.</i>`,
      keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
    };
  }
  const listing = vendors
    .slice(0, 12)
    .map((v, i) => {
      const name = String(v.name ?? "Vendor");
      const code = v.code ? String(v.code) : "";
      const contact = [v.contact, v.phone, v.email].map((x) => String(x ?? "").trim()).filter(Boolean).join(" · ");
      const bits = [code && `(${code})`, contact].filter(Boolean).join(" ");
      return `<b>${i + 1}. ${esc(name)}</b>${bits ? ` — ${esc(bits)}` : ""}`;
    })
    .join("\n");
  const btns = vendors.slice(0, 12).map((v, i) => {
    const name = String(v.name ?? "Vendor");
    const code = v.code ? ` (${String(v.code)})` : "";
    return {
      text: truncate(`${name}${code}`, 32),
      callback_data: `rq:mv:vendor:${i}`,
    };
  });
  return {
    text: `${nodeText(node, vars)}\n\n${listing}`,
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
  };
}

async function renderDepartmentPick(
  db: Db,
  request: ItemRequest,
  node: FlowNode,
  vars: Record<string, string>
): Promise<MoveRender> {
  const departments = await activeDepartments(db);
  if (!departments.length) {
    return {
      text: `${nodeText(node, vars)}\n\n<i>No Active departments in Department Master. Add departments in the console, then try again.</i>`,
      keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
    };
  }
  const btns = departments.slice(0, 12).map((d, i) => ({
    text: truncate(String(d.name ?? "Department"), 32),
    callback_data: `rq:mv:dept:${i}`,
  }));
  return {
    text: nodeText(node, vars),
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
  };
}

function renderQty(request: ItemRequest, node: FlowNode, vars: Record<string, string>): MoveRender {
  const draft = request.ui.moveQtyDraft ?? "";
  const text = nodeText(node, { ...vars, qty: `<b>${draft || "—"}</b>` });
  const key = (d: string) => ({ text: d, callback_data: `rq:mv:q:${d}` });
  return {
    text,
    keyboard: [
      ["1", "2", "3"].map(key),
      ["4", "5", "6"].map(key),
      ["7", "8", "9"].map(key),
      [key("."), key("0"), { text: "⌫", callback_data: "rq:mv:q:del" }],
      [{ text: "✔ Next", callback_data: "rq:mv:q:ok" }],
      [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
      footer(request),
    ],
  };
}

function renderQuestion(request: ItemRequest, node: FlowNode, vars: Record<string, string>): MoveRender {
  const q = node.question;
  const label = q?.label || node.label;
  const text = `${nodeText(node, { ...vars, question: label })}\n\n<b>${esc(label)}</b>${q?.required ? " *" : ""}`;

  if (!q || q.type === "string") {
    const kb: InlineKeyboard = [];
    if (q && !q.required) kb.push([{ text: "Skip ⤵", callback_data: "rq:mv:qa:skip" }]);
    kb.push([{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request));
    return {
      text: `${text}\n\n<i>Send a message in this group with your answer.</i>`,
      keyboard: kb,
    };
  }
  if (q.type === "boolean") {
    return {
      text,
      keyboard: [
        [
          { text: "Yes", callback_data: "rq:mv:qa:yes" },
          { text: "No", callback_data: "rq:mv:qa:no" },
        ],
        [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
        footer(request),
      ],
    };
  }
  if (q.type === "select") {
    const btns = (q.options ?? []).slice(0, 12).map((o, i) => ({
      text: truncate(o, 32),
      callback_data: `rq:mv:qo:${i}`,
    }));
    return {
      text,
      keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
    };
  }
  // number
  const draft = request.ui.moveNumberDraft ?? "";
  const key = (d: string) => ({ text: d, callback_data: `rq:mv:qn:${d}` });
  const kb: InlineKeyboard = [
    ["1", "2", "3"].map(key),
    ["4", "5", "6"].map(key),
    ["7", "8", "9"].map(key),
    [key("."), key("0"), { text: "⌫", callback_data: "rq:mv:qn:del" }],
    [{ text: "✔ Next", callback_data: "rq:mv:qn:ok" }],
  ];
  if (q && !q.required) kb.push([{ text: "Skip ⤵", callback_data: "rq:mv:qa:skip" }]);
  kb.push([{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request));
  return {
    text: `${text}\n\nValue: <b>${draft || "—"}</b>${q?.placeholder ? `\n<i>${esc(q.placeholder)}</i>` : ""}`,
    keyboard: kb,
  };
}

function renderTextCapture(
  request: ItemRequest,
  node: FlowNode,
  vars: Record<string, string>,
  type: MovementType | null
): MoveRender {
  const current = node.kind === "reference" ? request.ui.moveReference : request.ui.moveRemarks;
  const required =
    (node.kind === "reference" && type?.requireReference) || (node.kind === "remarks" && type?.requireRemarks);
  const kb: InlineKeyboard = [];
  if (!required) kb.push([{ text: "Skip ⤵", callback_data: "rq:mv:skip" }]);
  kb.push([{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request));
  return {
    text: `${nodeText(node, vars)}${required ? " *" : ""}${
      current ? `\n\nCurrent: <i>${esc(current)}</i>` : "\n\n<i>Send a message with your answer.</i>"
    }`,
    keyboard: kb,
  };
}

async function movementSummaryLines(
  db: Db,
  request: ItemRequest,
  hit: StockHit | null,
  type: MovementType | null
): Promise<string[]> {
  const qty = request.ui.moveQtyDraft || "—";
  const loc =
    (request.ui.moveLocationId || request.ui.focusLocationId
      ? await locationPathById(db, (request.ui.moveLocationId || request.ui.focusLocationId)!)
      : "") || "—";
  const wf = await loadWorkflow(db);
  const receiving = type?.direction === "in";
  const locLabel =
    type?.code === "new-purchase" ? "Receive at" : receiving ? "Return to" : "From";
  const out: string[] = [
    type ? `<b>${esc(type.name)}</b>` : "",
    "",
    hit ? `Item: ${esc(hit.name)}` : "",
    `Quantity: ${esc(qty)} ${esc(hit?.unit ?? "")}`,
    `${locLabel}: ${esc(loc)}`,
  ];
  if (request.ui.moveVendorName) out.push(`Vendor: ${esc(request.ui.moveVendorName)}`);
  if (request.ui.moveDepartmentName) out.push(`Department: ${esc(request.ui.moveDepartmentName)}`);
  for (const [qid, a] of Object.entries(request.ui.moveAnswers ?? {})) {
    const qNode = Object.values(wf.nodes).find((n) => n.question?.id === qid);
    const label = qNode?.question?.label || qNode?.label || "Answer";
    out.push(`${esc(label)}: ${esc(a.display)}`);
  }
  if (request.ui.moveReference) out.push(`Reference: ${esc(request.ui.moveReference)}`);
  if (request.ui.moveRemarks) out.push(`Remarks: ${esc(request.ui.moveRemarks)}`);
  return out.filter(Boolean);
}

async function renderReview(
  db: Db,
  request: ItemRequest,
  node: FlowNode,
  hit: StockHit | null,
  type: MovementType | null,
  vars: Record<string, string>
): Promise<MoveRender> {
  const summary = await movementSummaryLines(db, request, hit, type);
  const text = [nodeText(node, vars), "", ...summary].filter(Boolean).join("\n");

  return {
    text,
    keyboard: [
      [{ text: "✔ Continue", callback_data: "rq:mv:next" }],
      [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
      footer(request),
    ],
  };
}

async function renderAddToCart(
  db: Db,
  request: ItemRequest,
  node: FlowNode,
  hit: StockHit | null,
  type: MovementType | null,
  vars: Record<string, string>
): Promise<MoveRender> {
  const summary = await movementSummaryLines(db, request, hit, type);
  const text = [nodeText(node, vars), "", ...summary, "", "Add this movement to your cart?"].filter(Boolean).join("\n");

  return {
    text,
    keyboard: [
      [{ text: "✔ Add to cart", callback_data: "rq:mv:cart" }],
      [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
      footer(request),
    ],
  };
}

async function advance(db: Db, request: ItemRequest): Promise<MoveRender> {
  const wf = await loadWorkflow(db);
  const id = request.ui.flowNodeId;
  if (!id) return startConfiguredFlow(db, request);
  const next = nextNodeId(wf, id);
  if (!next) {
    // No more nodes — treat as ready to cart
    request.ui.flowNodeId = id;
    return renderMoveFlow(db, request);
  }
  request.ui.flowNodeId = next;
  return renderMoveFlow(db, request);
}

async function goBack(db: Db, request: ItemRequest): Promise<MoveRender> {
  const wf = await loadWorkflow(db);
  const id = request.ui.flowNodeId;
  if (!id) return startSearchFlow(db, request, request.ui.query || "");
  const prev = prevNodeId(wf, id);
  if (!prev) {
    clearMoveUi(request.ui);
    request.ui.focusProductId = null;
    request.ui.focusLocationId = null;
    request.ui.intentLocationPicked = false;
    request.ui.query = "";
    return { text: "Cancelled. Type an item name to search again.", keyboard: [footer(request)] };
  }
  request.ui.flowNodeId = prev;
  // Skip silent stock-effect markers when walking back.
  for (let i = 0; i < 20; i++) {
    const cur = currentNode(wf, request);
    if (!cur || (cur.kind !== "stock_in" && cur.kind !== "stock_out")) break;
    const skipPrev = prevNodeId(wf, cur.id);
    if (!skipPrev) break;
    request.ui.flowNodeId = skipPrev;
  }
  const prevNode = currentNode(wf, request);
  if (prevNode && (prevNode.kind === "search" || prevNode.kind === "pick_category")) {
    request.ui.focusProductId = null;
    request.ui.focusLocationId = null;
    request.ui.moveTypeCode = null;
    request.ui.moveLocationId = null;
    request.ui.moveFromLocationId = null;
    request.ui.moveToLocationId = null;
    request.ui.moveQtyDraft = "";
    request.ui.moveAnswers = {};
  }
  return renderMoveFlow(db, request);
}

function branchContains(wf: SearchMoveWorkflow, startId: string, targetId: string): boolean {
  if (startId === targetId) return true;
  const n = wf.nodes[startId];
  if (!n) return false;
  return n.children.some((c) => branchContains(wf, c, targetId));
}

export function isMoveCallback(data: string): boolean {
  return data.startsWith("rq:mv:");
}

export async function applyMoveCallback(
  db: Db,
  request: ItemRequest,
  data: string,
  _by: string
): Promise<MoveResult> {
  if (!request.ui.flowNodeId && data !== "rq:mv:rec") {
    // Auto-enter if somehow mid-product without cursor
    if (request.ui.focusProductId) {
      await startConfiguredFlow(db, request);
    }
  }

  const wf = await loadWorkflow(db);
  const node = currentNode(wf, request);
  const hit = await focusedProduct(db, request);

  if (data === "rq:mv:back") return { render: await goBack(db, request) };
  if (data === "rq:mv:next" || data === "rq:mv:skip") {
    if (data === "rq:mv:next" && node?.kind === "pick_vendor" && !request.ui.moveVendorId) {
      return { notice: "Pick a vendor first." };
    }
    if (data === "rq:mv:next" && node?.kind === "pick_department" && !request.ui.moveDepartmentId) {
      return { notice: "Pick a department first." };
    }
    if (data === "rq:mv:next" && node?.kind === "reference") {
      const type = request.ui.moveTypeCode
        ? (await loadManualTypes(db)).find((t) => t.code === request.ui.moveTypeCode)
        : null;
      if (type?.requireReference && !String(request.ui.moveReference ?? "").trim()) {
        return { notice: "A reference is required for this movement." };
      }
    }
    if (data === "rq:mv:skip" && node?.kind === "reference") {
      const type = request.ui.moveTypeCode
        ? (await loadManualTypes(db)).find((t) => t.code === request.ui.moveTypeCode)
        : null;
      if (type?.requireReference) {
        return { notice: "A reference is required for this movement." };
      }
    }
    return { render: await advance(db, request) };
  }
  if (data === "rq:mv:cart") {
    if (!request.ui.moveLocationId && !request.ui.focusLocationId) {
      return { notice: "Pick a storage location first." };
    }
    if (!request.ui.moveQtyDraft) return { notice: "Enter a quantity first." };
    // Vendor required when the branch includes pick_vendor (any saved vendor pick or type).
    const hasVendorStep = Object.values(wf.nodes).some(
      (n) =>
        n.kind === "pick_vendor" &&
        movementBranches(wf).some(
          (m) => m.movementCode === request.ui.moveTypeCode && branchContains(wf, m.id, n.id)
        )
    );
    if (hasVendorStep && !request.ui.moveVendorId) {
      return { notice: "Pick a vendor first." };
    }
    const hasDeptStep = Object.values(wf.nodes).some(
      (n) =>
        n.kind === "pick_department" &&
        movementBranches(wf).some(
          (m) => m.movementCode === request.ui.moveTypeCode && branchContains(wf, m.id, n.id)
        )
    );
    if (hasDeptStep && !request.ui.moveDepartmentId) {
      return { notice: "Pick a department first." };
    }
    const typeForCart = request.ui.moveTypeCode
      ? (await loadManualTypes(db)).find((t) => t.code === request.ui.moveTypeCode)
      : null;
    if (typeForCart?.requireReference && !String(request.ui.moveReference ?? "").trim()) {
      return { notice: "A reference is required for this movement." };
    }
    if (request.ui.moveTypeCode === "new-purchase") {
      const hasStatus = Object.values(request.ui.moveAnswers ?? {}).some((a) =>
        /received|expected|ordered/i.test(String(a.display ?? ""))
      );
      if (!hasStatus) {
        return { notice: "Pick Expected or Received status first." };
      }
    }
    return { addToCart: true };
  }
  if (data === "rq:mv:rec") return { render: await startConfiguredFlow(db, request) };

  // Movement type pick → enter that movement's branch tree
  if (data.startsWith("rq:mv:t:")) {
    const idx = Number(data.slice("rq:mv:t:".length));
    const branches = movementBranches(wf);
    const types = await loadManualTypes(db);
    const byCode = new Map(types.map((t) => [t.code, t]));
    const ordered = branches.length
      ? branches.map((b) => byCode.get(b.movementCode || "")).filter((t): t is MovementType => Boolean(t))
      : types;
    const picked = ordered[idx];
    if (!picked) return { notice: "That movement is no longer available." };
    request.ui.moveTypeCode = picked.code;
    const entered = enterMovementBranch(wf, picked.code);
    if (entered) {
      request.ui.flowNodeId = entered;
      return { render: await renderMoveFlow(db, request) };
    }
    return { render: await advance(db, request) };
  }

  // Vendor Master pick
  if (data.startsWith("rq:mv:vendor:")) {
    const idx = Number(data.slice("rq:mv:vendor:".length));
    const vendors = await activeVendors(db);
    const v = vendors[idx];
    if (!v) return { notice: "That vendor is no longer available." };
    request.ui.moveVendorId = v._id.toString();
    request.ui.moveVendorName = String(v.name ?? "");
    return { render: await advance(db, request) };
  }

  // Department Master pick
  if (data.startsWith("rq:mv:dept:")) {
    const idx = Number(data.slice("rq:mv:dept:".length));
    const departments = await activeDepartments(db);
    const d = departments[idx];
    if (!d) return { notice: "That department is no longer available." };
    request.ui.moveDepartmentId = d._id.toString();
    request.ui.moveDepartmentName = String(d.name ?? "");
    return { render: await advance(db, request) };
  }

  // Stock-line location pick
  if (data.startsWith("rq:mv:sl:")) {
    const idx = Number(data.slice("rq:mv:sl:".length));
    const line = hit?.lines[idx];
    if (!line) return { notice: "That location is gone." };
    request.ui.moveLocationId = line.locationId;
    request.ui.focusLocationId = line.locationId;
    request.ui.intentLocationPicked = true;
    return { render: await advance(db, request) };
  }

  // Location tree browse / select
  if (data === "rq:mv:up") {
    const stack = request.ui.locStack ?? [];
    const prev = stack.pop() ?? null;
    request.ui.locStack = stack;
    request.ui.locCursor = prev;
    return { render: await renderMoveFlow(db, request) };
  }
  if (data.startsWith("rq:mv:loc:") || data.startsWith("rq:mv:sel:")) {
    const drill = data.startsWith("rq:mv:loc:");
    const idx = Number(data.slice(drill ? "rq:mv:loc:".length : "rq:mv:sel:".length));
    const kids = await locationChildren(db, request.ui.locCursor ?? null);
    const loc = kids[idx];
    if (!loc) return { notice: "That location is gone." };
    if (drill) {
      request.ui.locStack = [...(request.ui.locStack ?? []), request.ui.locCursor ?? ""].filter((x) => x !== undefined);
      // store previous cursor
      const stack = [...(request.ui.locStack ?? [])];
      if (request.ui.locCursor) stack.push(request.ui.locCursor);
      request.ui.locStack = stack;
      request.ui.locCursor = loc.id;
      return { render: await renderMoveFlow(db, request) };
    }
    if (node?.kind === "from") request.ui.moveFromLocationId = loc.id;
    else if (node?.kind === "to") request.ui.moveToLocationId = loc.id;
    else {
      request.ui.moveLocationId = loc.id;
      request.ui.focusLocationId = loc.id;
      request.ui.intentLocationPicked = true;
    }
    request.ui.locCursor = null;
    request.ui.locStack = [];
    return { render: await advance(db, request) };
  }

  // Qty pad
  if (data.startsWith("rq:mv:q:")) {
    const pressed = data.slice("rq:mv:q:".length);
    let draft = request.ui.moveQtyDraft ?? "";
    if (pressed === "ok") {
      if (!draft) return { notice: "Enter a quantity first." };
      const qty = Number(draft);
      if (!Number.isFinite(qty) || qty <= 0) return { notice: "Enter a valid quantity." };

      const locationId = request.ui.moveLocationId || request.ui.focusLocationId || request.ui.moveFromLocationId;
      const hit = await focusedProduct(db, request);
      const moveCode = request.ui.moveTypeCode || undefined;
      const type = moveCode
        ? (await loadManualTypes(db)).find((t) => t.code === moveCode) ?? null
        : null;
      const moveNode =
        moveCode
          ? Object.values(wf.nodes).find((n) => n.kind === "movement" && n.movementCode === moveCode)
          : null;
      const branchQuestions = moveNode ? collectQuestions(wf, moveNode.id) : [];
      const stockEffect =
        resolveStockEffectFromAnswers(branchQuestions, request.ui.moveAnswers) ||
        (moveNode ? resolveStockEffectFromBranch(wf, moveNode.id) : undefined);
      const inbound = isInboundMovement({
        stockEffect,
        movementDirection: type?.direction,
        movementCode: moveCode,
      });

      if (!inbound && hit && locationId) {
        const locationPath = await locationPathById(db, locationId);
        const shortage = await findOutboundShortage(db, {
          productId: hit.productId,
          productName: hit.name,
          productNumber: hit.productNumber,
          locationId,
          locationPath: locationPath || "(unknown location)",
          unit: hit.unit,
          qty,
          inbound: false,
        });
        if (shortage) {
          await persistOutboundShortage(db, request, shortage, "qty", {
            code: moveCode,
            name: type?.name,
          });
          note(
            request,
            request.requesterName || "Requester",
            `Out of stock at qty: ${hit.name} — requested ${money(qty)} ${hit.unit}, available ${money(shortage.available)}.`
          );
          return {
            render: {
              text: [
                `⚠️ <b>Out of stock</b>`,
                "",
                type ? `<b>${esc(type.name)}</b>` : "",
                `Item: ${esc(shortage.productName)}`,
                `Location: ${esc(shortage.locationPath)}`,
                `Requested: ${money(shortage.qtyRequested)} ${esc(shortage.unit)}`,
                `Available: ${money(shortage.available)} ${esc(shortage.unit)}`,
                "",
                "<i>This shortage was recorded. Enter a lower quantity or pick another location.</i>",
              ]
                .filter(Boolean)
                .join("\n"),
              keyboard: [
                [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
                footer(request),
              ],
            },
            notice: "Out of stock — not enough available at that location.",
          };
        }
      }

      return { render: await advance(db, request) };
    }
    if (pressed === "del") draft = draft.slice(0, -1);
    else if (pressed === ".") {
      if (draft.includes(".")) return { notice: "Only one decimal point." };
      draft = draft === "" ? "0." : `${draft}.`;
    } else {
      draft = draft === "0" ? pressed : draft + pressed;
    }
    request.ui.moveQtyDraft = draft;
    return { render: await renderMoveFlow(db, request) };
  }

  // Question answers
  if (data.startsWith("rq:mv:qa:")) {
    const ans = data.slice("rq:mv:qa:".length);
    const q = node?.question;
    if (ans === "skip") return { render: await advance(db, request) };
    if (q) {
      const value = ans === "yes" ? true : ans === "no" ? false : ans;
      const display = ans === "yes" ? "Yes" : ans === "no" ? "No" : String(ans);
      request.ui.moveAnswers = {
        ...(request.ui.moveAnswers ?? {}),
        [q.id]: { value, display },
      };
    }
    return { render: await advance(db, request) };
  }
  if (data.startsWith("rq:mv:qo:")) {
    const idx = Number(data.slice("rq:mv:qo:".length));
    const q = node?.question as MoveQuestion | undefined;
    const opt = q?.options?.[idx];
    if (!q || !opt) return { notice: "That option is gone." };
    request.ui.moveAnswers = {
      ...(request.ui.moveAnswers ?? {}),
      [q.id]: { value: opt, display: opt },
    };
    return { render: await advance(db, request) };
  }
  if (data.startsWith("rq:mv:qn:")) {
    const pressed = data.slice("rq:mv:qn:".length);
    let draft = request.ui.moveNumberDraft ?? "";
    if (pressed === "ok") {
      const q = node?.question;
      if (!draft && q && !q.required) {
        request.ui.moveNumberDraft = "";
        return { render: await advance(db, request) };
      }
      if (!draft) return { notice: "Enter a value first, or Skip." };
      if (q) {
        request.ui.moveAnswers = {
          ...(request.ui.moveAnswers ?? {}),
          [q.id]: { value: Number(draft) || 0, display: draft || "0" },
        };
      }
      request.ui.moveNumberDraft = "";
      return { render: await advance(db, request) };
    }
    if (pressed === "del") draft = draft.slice(0, -1);
    else draft = draft + pressed;
    request.ui.moveNumberDraft = draft;
    return { render: await renderMoveFlow(db, request) };
  }

  return { notice: "Use the buttons above." };
}

export async function applyMoveMessage(db: Db, request: ItemRequest, text: string): Promise<MoveResult | null> {
  if (!request.ui.flowNodeId) return null;
  const wf = await loadWorkflow(db);
  const node = currentNode(wf, request);
  if (!node) return null;

  if (node.kind === "question" && node.question?.type === "string") {
    const q = node.question;
    request.ui.moveAnswers = {
      ...(request.ui.moveAnswers ?? {}),
      [q.id]: { value: text, display: text },
    };
    return { render: await advance(db, request) };
  }
  if (node.kind === "reference") {
    const trimmed = text.trim();
    const type = request.ui.moveTypeCode
      ? (await loadManualTypes(db)).find((t) => t.code === request.ui.moveTypeCode)
      : null;
    if (type?.requireReference && !trimmed) {
      return { notice: "A reference is required for this movement." };
    }
    request.ui.moveReference = trimmed;
    return { render: await advance(db, request) };
  }
  if (node.kind === "remarks") {
    request.ui.moveRemarks = text;
    return { render: await advance(db, request) };
  }
  return null;
}
