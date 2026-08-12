import type { Db } from "mongodb";
import { categoryChildNames, resolveCategoryPathForItem, rootCategoryNames } from "./categories";
import { locationChildren, locationParentIds, locationPathById, flatSelectableLocations } from "./locations";
import { parseQuantityRepeat, pressQuantityKey, quantityRepeatHint, draftQtyParts, reviewQuantityLines, formatQtyUnit } from "./quantity-repeat";
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
import { activePlants } from "./plants";
import {
  activeMaintenanceUsers,
  activeWorkers,
  BORROW_MOVEMENT_CODE,
  ensureBorrowMovementType,
} from "./borrowing";
import { groupConfig } from "./telegram-health";
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
  ui.moveVendorQuery = "";
  ui.movePlantId = null;
  ui.movePlantName = null;
  ui.movePlantQuery = "";
  ui.moveDepartmentId = null;
  ui.moveDepartmentName = null;
  ui.moveMaintenanceUserId = null;
  ui.moveMaintenanceUserName = null;
  ui.moveBorrowerId = null;
  ui.moveBorrowerName = null;
  ui.moveBorrowerSelf = null;
  ui.borrowChoiceStage = null;
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

async function loadWorkflow(db: Db, chatId?: string): Promise<SearchMoveWorkflow> {
  // Borrow is offered from the same keyboard as every other movement, and that
  // keyboard is built by filtering the tree's branches against Movement Master
  // — so a missing Borrow row there means the branch exists but the button
  // never appears. Ensured here rather than in the workflow module, which is
  // also bundled into the client-side builder. Cached, so it is one round trip
  // per process, not one per tap.
  await ensureBorrowMovementType(db).catch(() => {});
  if (!chatId) return getSearchMoveWorkflow(db);
  try {
    const { mode } = await groupConfig(db, chatId);
    return getSearchMoveWorkflow(db, chatId, { mode });
  } catch {
    return getSearchMoveWorkflow(db, chatId);
  }
}

async function loadManualTypes(db: Db, chatId?: string): Promise<MovementType[]> {
  const docs = await activeMovementTypes(db);
  const all = docs
    .map(toMovementType)
    .filter((t) => !t.isSystem && t.status === "Active");
  const wf = await loadWorkflow(db, chatId);
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
  const parsed = parseQuantityRepeat(request.ui.moveQtyDraft || "");
  const qtyDisplay = parsed.ok ? formatQtyUnit(parsed.value.qty, hit?.unit ?? "") : request.ui.moveQtyDraft || "—";
  return {
    product: hit ? `${hit.name}${hit.category ? ` · ${hit.category}` : ""}` : request.ui.query || "",
    type: type?.name ?? "",
    unit: hit?.unit ?? "",
    qty: qtyDisplay,
    where: where || "—",
    stock_lines: stockLines,
    children,
    vendor: request.ui.moveVendorName || "",
    plant: request.ui.movePlantName || "",
    department: request.ui.moveDepartmentName || "",
    maintenance_user: request.ui.moveMaintenanceUserName || "",
    borrower: request.ui.moveBorrowerName || "",
    question: "",
  };
}

function nodeText(node: FlowNode, vars: Record<string, string>): string {
  return applyMessageTemplate(node.message || node.label, vars).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Categories offered on the pick_category step: Category Master only.
 * When the query matches a master node (or Nemotron picks one), that path is
 * auto-applied and this returns a single name so the UI can skip a noisy list.
 */
export async function categoryPickOptions(db: Db, query: string): Promise<string[]> {
  const resolved = await resolveCategoryPathForItem(db, query);
  if (resolved.path.length) return [resolved.path[resolved.path.length - 1]];
  return rootCategoryNames(db);
}

/** Auto-fill categoryPath from Category Master (+ Nemotron) when still empty. */
export async function ensureCategoryPathFromMaster(
  db: Db,
  ui: ItemRequest["ui"]
): Promise<"matched" | "none"> {
  if (categoryPathOf(ui).length) return "matched";
  const query = String(ui.query ?? "").trim();
  if (!query) return "none";
  const resolved = await resolveCategoryPathForItem(db, query);
  if (!resolved.path.length) return "none";
  setCategoryPath(ui, resolved.path);
  return "matched";
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
  const wf = await loadWorkflow(db, request.chatId);
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
  const wf = await loadWorkflow(db, request.chatId);
  const next = nodeAfterDiscovery(wf) ?? wf.rootId;
  request.ui.flowNodeId = next;
  request.ui.intent = "move";
  request.ui.moveStage = "type";
  return renderMoveFlow(db, request);
}

/** @deprecated — prefer startSearchFlow / continueAfterProductPick */
export async function startConfiguredFlow(db: Db, request: ItemRequest): Promise<MoveRender> {
  if (request.ui.focusProductId) return continueAfterProductPick(db, request);
  const wf = await loadWorkflow(db, request.chatId);
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
  const wf = await loadWorkflow(db, request.chatId);
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
    ? (await loadManualTypes(db, request.chatId)).find((t) => t.code === request.ui.moveTypeCode) ?? null
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
    case "pick_plant":
      return renderPlantPick(db, request, node, vars);
    case "pick_department":
      return renderDepartmentPick(db, request, node, vars);
    case "pick_maintenance_user":
      return renderMaintenanceUserPick(db, request, node, vars);
    case "pick_borrower":
      return renderBorrowerPick(db, request, node, vars);
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

  // If the flowchart includes Pick category:
  // - Existing products for the query → show them with their Product Master category (no re-ask).
  // - No products → Category Master match / drill (new-product path).
  if (leadInHasKind(wf, "pick_category")) {
    const hits = await lookupProducts(db, ui.query);
    const path = categoryPathOf(ui);

    if (hits.length > 0 && !path.length) {
      return renderProductResults(db, request, node, vars);
    }

    if (!path.length) {
      const matched = await ensureCategoryPathFromMaster(db, ui);
      if (!matched) {
        const roots = await rootCategoryNames(db);
        if (roots.length > 1) {
          const catNode = leadInNode(wf, "pick_category");
          request.ui.flowNodeId = catNode?.id ?? request.ui.flowNodeId;
          return renderCategoryNode(db, request, catNode ?? node, vars);
        }
        if (roots.length === 1) setCategoryPath(ui, [roots[0]]);
      }
    }

    const effectivePath = categoryPathOf(ui);
    if (effectivePath.length && hits.length === 0) {
      const kids = await resolveCategoryChildren(db, effectivePath, []);
      if (kids.length > 0) {
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

    if (effectivePath.length && hits.length > 0) {
      const rootHits = hits.filter((h) => (String(h.category ?? "").trim() || "Other") === effectivePath[0]);
      const kids = await resolveCategoryChildren(db, effectivePath, rootHits);
      if (kids.length > 1) {
        const catNode = leadInNode(wf, "pick_category");
        if (catNode) request.ui.flowNodeId = catNode.id;
        return renderCategoryDrillNode(request, catNode ?? node, vars, kids);
      }
      if (kids.length === 1 && effectivePath.length < 20) {
        setCategoryPath(ui, [...effectivePath, kids[0]]);
        return renderSearchNode(db, request, wf, node, vars);
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
  const path = categoryPathOf(request.ui);

  if (!path.length) {
    await ensureCategoryPathFromMaster(db, request.ui);
  }
  const effectivePath = categoryPathOf(request.ui);

  if (effectivePath.length) {
    const rootHits = hits.filter((h) => (String(h.category ?? "").trim() || "Other") === effectivePath[0]);
    const kids = await resolveCategoryChildren(db, effectivePath, rootHits);
    if (kids.length > 1) {
      return renderCategoryDrillNode(request, node, vars, kids);
    }
    if (kids.length === 1 && effectivePath.length < 20) {
      setCategoryPath(request.ui, [...effectivePath, kids[0]]);
      return renderCategoryNode(db, request, node, vars);
    }
    // Leaf reached — show items using search messaging.
    const wf = await loadWorkflow(db, request.chatId);
    const search = leadInNode(wf, "search") ?? node;
    return renderProductResults(db, request, search, vars);
  }

  // Unmatched query: Category Master roots only (never invent categories from products).
  const categories = await rootCategoryNames(db);
  if (categories.length <= 1) {
    if (categories[0]) setCategoryPath(request.ui, [categories[0]]);
    const wf = await loadWorkflow(db, request.chatId);
    const search = leadInNode(wf, "search") ?? node;
    return renderSearchNode(db, request, wf, search, vars);
  }

  const prompt = nodeText(node, { ...vars, product: request.ui.query || "" });
  const btns = categories.map((c, i) => ({
    text: truncate(c, 30),
    callback_data: `rq:cat:${i}`,
  }));
  return {
    text: `${prompt}\n\n<b>${categories.length} categories</b> (from Category Master)`,
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

  // Single clear match — the product's details, including where it actually is.
  //
  // The location is named HERE and only here when one shelf holds it: the
  // picker that would normally come next resolves itself in that case (see
  // `autoSelectsSingleLocation`), so the caller reads the location once. When
  // several shelves hold it there is no single "exact location" to state, so
  // this screen counts them and the picker names them — again, once.
  if (hits.length === 1) {
    const hit = hits[0];
    const cat = [hit.category, hit.subcategory].filter(Boolean).join(" → ");
    const only = hit.lines.length === 1 ? hit.lines[0] : null;
    return {
      text: [
        `<b>Product found</b>`,
        "",
        `<b>${esc(hit.name)}</b>${hit.unit ? ` — ${esc(hit.unit)}` : ""}`,
        cat ? `\nCategory:\n${esc(cat)}` : "",
        "",
        `On hand: <b>${money(hit.total)}</b>${hit.unit ? ` ${esc(hit.unit)}` : ""}`,
        only
          ? `📍 Location: <b>${esc(only.locationPath)}</b> — ${money(only.qty)}${
              only.unit ? ` ${esc(only.unit)}` : ""
            }`
          : hit.lines.length
            ? `<i>Held at ${hit.lines.length} locations — pick one next.</i>`
            : `<i>No stock on any shelf yet.</i>`,
      ]
        .filter(Boolean)
        .join("\n"),
      keyboard: [
        [{ text: "✔ Use this product", callback_data: "rq:s:0" }],
        [{ text: "⬅ Back", callback_data: "rq:back" }],
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
    const cat = [hit.category, hit.subcategory].filter(Boolean).join(" → ");
    lines.push(
      `<b>${start + i + 1}. ${esc(hit.name)}</b>${hit.unit ? ` — ${esc(hit.unit)}` : ""}` +
        (cat ? `\n   ${esc(cat)}` : "") +
        ` · ${money(hit.total)} on hand`
    );
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
  const wf = await loadWorkflow(db, request.chatId);
  const branches = movementBranches(wf);
  const all = await loadManualTypes(db, request.chatId);
  const byCode = new Map(all.map((t) => [t.code, t]));

  const btns = (branches.length
    ? branches
        .map((b) => {
          const t = byCode.get(b.movementCode || "");
          if (!t) return null;
          return { type: t, label: b.label || t.name };
        })
        .filter((x): x is { type: MovementType; label: string } => Boolean(x))
    : all.map((t) => ({ type: t, label: t.name }))
  ).map((row, i) => ({
    text: truncate(row.label, 34),
    callback_data: `rq:mv:t:${i}`,
  }));

  return {
    text: nodeText(node, vars),
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
  };
}

/**
 * True when a location step has exactly one possible answer and should resolve
 * itself instead of being shown.
 *
 * Only ever for stock LEAVING: an outbound step can only offer shelves that
 * already hold the item, so one stock line means one answer. An inbound step
 * (a purchase, a return) is choosing where material should go, which is a real
 * question however few shelves currently hold it.
 */
async function autoSelectsSingleLocation(
  db: Db,
  request: ItemRequest,
  mode: "location" | "from" | "to",
  type: MovementType | null
): Promise<boolean> {
  if (mode === "to") return false;
  if (type?.direction === "in") return false;
  if (request.ui.moveTypeCode === "warehouse-transfer") return false;
  const hit = await focusedProduct(db, request);
  return Boolean(hit && hit.lines.length === 1);
}

/** Would this node resolve itself rather than render? Back has to skip it too. */
async function isSilentNode(db: Db, request: ItemRequest, node: FlowNode): Promise<boolean> {
  if (node.kind === "stock_in" || node.kind === "stock_out") return true;
  const mode =
    node.kind === "pick_location" || node.kind === "location"
      ? "location"
      : node.kind === "from"
        ? "from"
        : null;
  if (!mode) return false;
  const type = request.ui.moveTypeCode
    ? (await loadManualTypes(db, request.chatId)).find((t) => t.code === request.ui.moveTypeCode) ?? null
    : null;
  return autoSelectsSingleLocation(db, request, mode, type);
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
    ? (await loadManualTypes(db, request.chatId)).find((t) => t.code === request.ui.moveTypeCode) ?? null
    : null;
  // Stock-out: offer shelves that already hold the item. Stock-in (return): browse
  // the full location tree so material can land anywhere, including empty bins.
  // Move Stock "from" uses stock lines when available; "to" always browses destinations.
  const receiving = type?.direction === "in" || mode === "to";
  const isMoveStock = request.ui.moveTypeCode === "warehouse-transfer";

  // One shelf holds it, so there is nothing to choose. The product screen has
  // already named that location; putting a one-button picker in front of the
  // user would show the same location a second time to ask a question with one
  // possible answer.
  if (await autoSelectsSingleLocation(db, request, mode, type)) {
    const only = hit?.lines[0];
    if (only) {
      if (mode === "from") {
        request.ui.moveFromLocationId = only.locationId;
        request.ui.moveLocationId = only.locationId;
        request.ui.focusLocationId = only.locationId;
      } else {
        request.ui.moveLocationId = only.locationId;
        request.ui.focusLocationId = only.locationId;
        request.ui.intentLocationPicked = true;
      }
      return advance(db, request);
    }
  }

  if (hit && hit.lines.length && !receiving && mode === "from") {
    const btns = hit.lines.slice(0, LOCATIONS_SHOWN).map((l, i) => ({
      text: `📍 ${truncate(l.locationPath, 28)} (${money(l.qty)})`,
      callback_data: `rq:mv:sl:${i}`,
    }));
    return {
      text: nodeText(node, vars),
      keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
    };
  }

  if (hit && hit.lines.length && !receiving && mode === "location" && !isMoveStock) {
    const btns = hit.lines.slice(0, LOCATIONS_SHOWN).map((l, i) => ({
      text: `📍 ${truncate(l.locationPath, 28)} (${money(l.qty)})`,
      callback_data: `rq:mv:sl:${i}`,
    }));
    return {
      text: nodeText(node, vars),
      keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
    };
  }

  // New Purchase / Return from Plant / Move Stock: flat location list (no deep hierarchy).
  if (
    isMoveStock ||
    (receiving &&
      (request.ui.moveTypeCode === "new-purchase" || request.ui.moveTypeCode === "return-from-plant"))
  ) {
    let options = await flatSelectableLocations(db);
    if (mode === "to" && request.ui.moveFromLocationId) {
      options = options.filter((o) => o.id !== request.ui.moveFromLocationId);
    }
    if (!options.length) {
      return {
        text: `${nodeText(node, vars)}\n\n<i>${
          mode === "to" && request.ui.moveFromLocationId
            ? "No other storage locations available as destination."
            : "No storage locations configured."
        }</i>`,
        keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
      };
    }
    const btns = options.slice(0, 20).map((o, i) => ({
      text: `📍 ${truncate(o.label, 30)}`,
      callback_data: `rq:mv:flat:${i}`,
    }));
    return {
      text: nodeText(node, vars),
      keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
    };
  }

  const parentIds = await locationParentIds(db);
  const cursor = request.ui.locCursor ?? null;
  let kids = await locationChildren(db, cursor);
  if (mode === "to" && request.ui.moveFromLocationId) {
    kids = kids.filter((l) => l._id.toString() !== request.ui.moveFromLocationId);
  }
  const btns = kids.slice(0, LOCATIONS_SHOWN).map((l, i) => {
    const id = l._id.toString();
    const hasKids = parentIds.has(id);
    return {
      text: `${hasKids ? "▸ " : "📍 "}${truncate(String(l.name ?? ""), 28)}`,
      callback_data: hasKids ? `rq:mv:loc:${i}` : `rq:mv:sel:${i}`,
    };
  });
  const nav: InlineKeyboard = [];
  if (cursor) nav.push([{ text: "⬆ Up", callback_data: "rq:mv:up" }]);
  nav.push([{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request));

  const levels = [
    ...new Set(kids.map((l) => String(l.level ?? "").trim()).filter(Boolean)),
  ];
  const levelHint =
    levels.length === 1
      ? `\n\n<b>Pick a ${levels[0]}</b>${kids.some((l) => parentIds.has(l._id.toString())) ? " (then keep going to the shelf)." : " — stock will sit here."}`
      : kids.length
        ? "\n\n<i>Location → Rack → Shelf</i>"
        : "\n\n<i>Nothing under here — tap Up.</i>";
  const here = cursor ? await locationPathById(db, cursor) : "";
  const head = nodeText(node, vars);
  const text = `${head}${here ? `\n<i>Current: ${here}</i>` : ""}${levelHint}`;

  return {
    text,
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

  const q = String(request.ui.moveVendorQuery ?? "")
    .trim()
    .toLowerCase();
  const filtered = q
    ? vendors.filter((v) => {
        const hay = [v.name, v.code, v.contact, v.phone, v.email]
          .map((x) => String(x ?? "").toLowerCase())
          .join(" ");
        return hay.includes(q);
      })
    : vendors;

  const listing = filtered
    .slice(0, 12)
    .map((v, i) => {
      const name = String(v.name ?? "Vendor");
      const code = v.code ? String(v.code) : "";
      return `<b>${i + 1}. ${esc(name)}</b>${code ? ` (${esc(code)})` : ""}`;
    })
    .join("\n");

  const btns = filtered.slice(0, 12).map((v, i) => {
    const name = String(v.name ?? "Vendor");
    return {
      text: truncate(name, 32),
      callback_data: `rq:mv:vendor:${i}`,
    };
  });

  const searchHint = q
    ? `\n\n🔍 Search: <b>${esc(request.ui.moveVendorQuery)}</b> — ${filtered.length} match${filtered.length === 1 ? "" : "es"}`
    : `\n\n<i>Type a vendor name to search Vendor Master.</i>`;

  return {
    text: `${nodeText(node, vars)}${searchHint}\n\n${listing || "<i>No vendors match that search.</i>"}`,
    keyboard: [
      ...buttonRows(btns, 1),
      ...(q ? [[{ text: "✖ Clear search", callback_data: "rq:mv:vendorclear" }]] : []),
      [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
      footer(request),
    ],
  };
}

async function renderPlantPick(
  db: Db,
  request: ItemRequest,
  node: FlowNode,
  vars: Record<string, string>
): Promise<MoveRender> {
  const plants = await activePlants(db);
  if (!plants.length) {
    return {
      text: `${nodeText(node, vars)}\n\n<i>No Active plants in Plant Master. Add plants in the console (or run npm run seed:plants), then try again.</i>`,
      keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
    };
  }

  const q = String(request.ui.movePlantQuery ?? "")
    .trim()
    .toLowerCase();
  const filtered = q
    ? plants.filter((p) => {
        const hay = [p.name, p.code, p.contact]
          .map((x) => String(x ?? "").toLowerCase())
          .join(" ");
        return hay.includes(q);
      })
    : plants;

  const listing = filtered
    .slice(0, 12)
    .map((p, i) => {
      const name = String(p.name ?? "Plant");
      const code = p.code ? String(p.code) : "";
      return `<b>${i + 1}. 🏭 ${esc(name)}</b>${code ? ` (${esc(code)})` : ""}`;
    })
    .join("\n");

  const btns = filtered.slice(0, 12).map((p, i) => ({
    text: truncate(`🏭 ${String(p.name ?? "Plant")}`, 32),
    callback_data: `rq:mv:plant:${i}`,
  }));

  const searchHint = q
    ? `\n\n🔍 Search: <b>${esc(request.ui.movePlantQuery)}</b> — ${filtered.length} match${filtered.length === 1 ? "" : "es"}`
    : `\n\n<i>Type a plant name to search Plant Master.</i>`;

  return {
    text: `${nodeText(node, vars)}${searchHint}\n\n${listing || "<i>No plants match that search.</i>"}`,
    keyboard: [
      ...buttonRows(btns, 1),
      ...(q ? [[{ text: "✖ Clear search", callback_data: "rq:mv:plantclear" }]] : []),
      [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
      footer(request),
    ],
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

async function renderMaintenanceUserPick(
  db: Db,
  request: ItemRequest,
  node: FlowNode,
  vars: Record<string, string>
): Promise<MoveRender> {
  const users = await activeMaintenanceUsers(db);
  if (!users.length) {
    return {
      text: `${nodeText(node, vars)}\n\n<i>No Active maintenance users. Add them in the console (or run npm run seed:borrow-masters), then try again.</i>`,
      keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
    };
  }
  const btns = users.slice(0, 12).map((u, i) => ({
    text: truncate(`👷 ${String(u.name ?? "Maintenance user")}`, 32),
    callback_data: `rq:mv:mu:${i}`,
  }));
  return {
    text: nodeText(node, vars),
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:back" }], footer(request)],
  };
}

// Himself / Other, and — once Other is tapped — the worker list, on the same
// node. They are one question ("who is actually taking this?") with a follow-up
// that only exists for one of the two answers, so splitting them into two
// flowchart steps would leave a step that is skipped half the time and a Back
// button that lands on nothing.
async function renderBorrowerPick(
  db: Db,
  request: ItemRequest,
  node: FlowNode,
  vars: Record<string, string>
): Promise<MoveRender> {
  const ui = request.ui;
  const owner = ui.moveMaintenanceUserName || "the maintenance user";

  if (ui.borrowChoiceStage !== "worker") {
    return {
      text: `${nodeText(node, vars)}\n\n<i>Recorded under ${esc(owner)} either way.</i>`,
      keyboard: [
        [{ text: `🙋 Himself (${truncate(owner, 22)})`, callback_data: "rq:mv:bself" }],
        [{ text: "👥 Other", callback_data: "rq:mv:bother" }],
        [{ text: "⬅ Back", callback_data: "rq:mv:back" }],
        footer(request),
      ],
    };
  }

  const workers = await activeWorkers(db);
  if (!workers.length) {
    return {
      text: `${nodeText(node, vars)}\n\n<i>No Active workers. Add them in the console (or run npm run seed:borrow-masters), then try again.</i>`,
      keyboard: [[{ text: "⬅ Back", callback_data: "rq:mv:bwho" }], footer(request)],
    };
  }
  const btns = workers.slice(0, 12).map((w, i) => ({
    text: truncate(String(w.name ?? "Worker"), 32),
    callback_data: `rq:mv:bw:${i}`,
  }));
  return {
    text:
      `${nodeText(node, vars)}\n\n<b>Who is taking it?</b>\n` +
      `<i>It stays on ${esc(owner)}'s account — the ticket shows who actually took it.</i>`,
    keyboard: [...buttonRows(btns, 1), [{ text: "⬅ Back", callback_data: "rq:mv:bwho" }], footer(request)],
  };
}

function renderQty(request: ItemRequest, node: FlowNode, vars: Record<string, string>): MoveRender {
  const draft = request.ui.moveQtyDraft ?? "";
  const parts = draftQtyParts(draft);
  const unit = vars.unit || "";
  const qtyLine = `Qty: <b>${esc(parts.qtyLabel)}</b>${unit ? ` ${esc(unit)}` : ""}`;
  const entriesLine = parts.hasTimes ? `\nEntries: <b>${esc(parts.entriesLabel || "—")}</b>` : "";
  // Prefer a clear how-many prompt; avoid templates that paste "12 × 5" into {{qty}} {{unit}}.
  const head = [vars.product, vars.type].filter(Boolean).join(" — ") || nodeText(node, { ...vars, qty: parts.qtyLabel });
  const text = `${head}\n\nHow many?\n\n${qtyLine}${entriesLine}\n\n${quantityRepeatHint()}`;
  const key = (d: string) => ({ text: d, callback_data: `rq:mv:q:${d}` });
  return {
    text,
    keyboard: [
      ["1", "2", "3"].map(key),
      ["4", "5", "6"].map(key),
      ["7", "8", "9"].map(key),
      [key("."), key("0"), { text: "⌫", callback_data: "rq:mv:q:del" }],
      [
        { text: "×", callback_data: "rq:mv:q:x" },
        { text: "✔ Next", callback_data: "rq:mv:q:ok" },
      ],
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
  const isTransfer = type?.direction === "transfer" || type?.code === "warehouse-transfer";
  const fromId = request.ui.moveFromLocationId || "";
  const toId = request.ui.moveToLocationId || "";
  const loc =
    (request.ui.moveLocationId || request.ui.focusLocationId
      ? await locationPathById(db, (request.ui.moveLocationId || request.ui.focusLocationId)!)
      : "") || "—";
  const fromPath = fromId ? (await locationPathById(db, fromId)) || "—" : "—";
  const toPath = toId ? (await locationPathById(db, toId)) || "—" : "—";
  const wf = await loadWorkflow(db, request.chatId);
  const receiving = type?.direction === "in";
  const locLabel =
    type?.code === "new-purchase"
      ? "Location"
      : type?.code === "return-from-plant"
        ? "Return To"
        : // A borrow leaves from the shelf the item was found on, and the
          // review already names who took it — "From" would read as a transfer.
          type?.code === BORROW_MOVEMENT_CODE
          ? "Location"
          : receiving
            ? "Location"
            : "From";

  const parsed = parseQuantityRepeat(request.ui.moveQtyDraft || "");
  const unit = hit?.unit ?? "";
  const qtyLines = parsed.ok
    ? reviewQuantityLines(parsed.value.qty, unit, parsed.value.times)
    : [`Quantity: ${request.ui.moveQtyDraft || "—"}${unit ? ` ${unit}` : ""}`];

  const categoryPath = categoryPathOf(request.ui);
  const categoryLabel =
    categoryPath.length > 0
      ? categoryPath.join(" → ")
      : [hit?.category, hit?.subcategory].filter(Boolean).join(" → ");

  const rebuilt: string[] = [
    hit ? `Item: ${esc(hit.name)}` : request.ui.query ? `Item: ${esc(request.ui.query)}` : "",
    categoryLabel ? `Category: ${esc(categoryLabel)}` : "",
    type ? `Action: ${esc(type.name)}` : "",
  ];
  for (const line of qtyLines) rebuilt.push(esc(line));
  if (isTransfer) {
    rebuilt.push(`From: ${esc(fromPath)}`);
    rebuilt.push(`To: ${esc(toPath)}`);
  } else {
    if (request.ui.movePlantName) rebuilt.push(`From Plant: ${esc(request.ui.movePlantName)}`);
    if (request.ui.moveVendorName) rebuilt.push(`Vendor: ${esc(request.ui.moveVendorName)}`);
    rebuilt.push(`${locLabel}: ${esc(loc)}`);
  }

  if (request.ui.moveDepartmentName) rebuilt.push(`Department: ${esc(request.ui.moveDepartmentName)}`);
  // Both names, always — "Borrowed by" is the whole point of the Other branch,
  // and stating it even when it repeats the account holder keeps the two lines
  // in the same place on every borrow ticket.
  if (request.ui.moveMaintenanceUserName) {
    rebuilt.push(`Maintenance User: ${esc(request.ui.moveMaintenanceUserName)}`);
  }
  if (request.ui.moveBorrowerName) {
    rebuilt.push(`Borrowed by: ${esc(request.ui.moveBorrowerName)}`);
  }
  for (const [qid, a] of Object.entries(request.ui.moveAnswers ?? {})) {
    const qNode = Object.values(wf.nodes).find((n) => n.question?.id === qid);
    const label = qNode?.question?.label || qNode?.label || "Answer";
    rebuilt.push(`${esc(label)}: ${esc(a.display)}`);
  }
  if (request.ui.moveReference) rebuilt.push(`Reference: ${esc(request.ui.moveReference)}`);
  if (request.ui.moveRemarks) rebuilt.push(`Remarks: ${esc(request.ui.moveRemarks)}`);
  return rebuilt.filter(Boolean);
}

async function renderReview(
  db: Db,
  request: ItemRequest,
  _node: FlowNode,
  hit: StockHit | null,
  type: MovementType | null,
  _vars: Record<string, string>
): Promise<MoveRender> {
  const summary = await movementSummaryLines(db, request, hit, type);
  // A borrow does not go in a cart — confirming it deducts the stock there and
  // then — so the button has to say what it actually does.
  const borrowing = request.ui.moveTypeCode === BORROW_MOVEMENT_CODE;
  const text = borrowing
    ? ["🔧 <b>Confirm borrowing</b>", "", ...summary, "", "<i>Confirming deducts this from stock straight away.</i>"]
        .filter(Boolean)
        .join("\n")
    : ["📋 <b>Review</b>", "", ...summary].filter(Boolean).join("\n");

  return {
    text,
    keyboard: [
      [
        {
          text: borrowing ? "✅ Confirm Borrow" : "🛒 Add to Cart",
          callback_data: "rq:mv:cart",
        },
      ],
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
  // Same screen as Review — no second "Add this line?" confirmation.
  return renderReview(db, request, node, hit, type, vars);
}

async function advance(db: Db, request: ItemRequest): Promise<MoveRender> {
  const wf = await loadWorkflow(db, request.chatId);
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
  const wf = await loadWorkflow(db, request.chatId);
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
  // Skip anything that renders nothing on the way forward — the silent
  // stock-effect markers, and a location step with only one possible answer.
  // Landing on one of those would auto-advance again and make Back a no-op.
  for (let i = 0; i < 20; i++) {
    const cur = currentNode(wf, request);
    if (!cur || !(await isSilentNode(db, request, cur))) break;
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

  const wf = await loadWorkflow(db, request.chatId);
  const node = currentNode(wf, request);
  const hit = await focusedProduct(db, request);

  if (data === "rq:mv:back") return { render: await goBack(db, request) };

  // Legacy Review "Continue" → same as Add to Cart (no extra confirm step).
  if (data === "rq:mv:next" && node?.kind === "review") {
    data = "rq:mv:cart";
  }

  if (data === "rq:mv:next" || data === "rq:mv:skip") {
    if (data === "rq:mv:next" && node?.kind === "pick_vendor" && !request.ui.moveVendorId) {
      return { notice: "Pick a vendor first." };
    }
    if (data === "rq:mv:next" && node?.kind === "pick_plant" && !request.ui.movePlantId) {
      return { notice: "Pick a plant first." };
    }
    if (data === "rq:mv:next" && node?.kind === "pick_department" && !request.ui.moveDepartmentId) {
      return { notice: "Pick a department first." };
    }
    if (data === "rq:mv:next" && node?.kind === "pick_maintenance_user" && !request.ui.moveMaintenanceUserId) {
      return { notice: "Pick the maintenance user first." };
    }
    if (data === "rq:mv:next" && node?.kind === "pick_borrower" && !request.ui.moveBorrowerName) {
      return { notice: "Say who is borrowing it — Himself or Other." };
    }
    if (data === "rq:mv:next" && node?.kind === "reference") {
      const type = request.ui.moveTypeCode
        ? (await loadManualTypes(db, request.chatId)).find((t) => t.code === request.ui.moveTypeCode)
        : null;
      if (type?.requireReference && !String(request.ui.moveReference ?? "").trim()) {
        return { notice: "A reference is required for this movement." };
      }
    }
    if (data === "rq:mv:skip" && node?.kind === "reference") {
      const type = request.ui.moveTypeCode
        ? (await loadManualTypes(db, request.chatId)).find((t) => t.code === request.ui.moveTypeCode)
        : null;
      if (type?.requireReference) {
        return { notice: "A reference is required for this movement." };
      }
    }
    return { render: await advance(db, request) };
  }
  if (data === "rq:mv:cart") {
    const isTransfer = request.ui.moveTypeCode === "warehouse-transfer";
    if (isTransfer) {
      if (!request.ui.moveFromLocationId) return { notice: "Pick where the stock is currently." };
      if (!request.ui.moveToLocationId) return { notice: "Pick where you want to move it." };
      if (request.ui.moveFromLocationId === request.ui.moveToLocationId) {
        return { notice: "Source and destination must be different." };
      }
    } else if (!request.ui.moveLocationId && !request.ui.focusLocationId) {
      return { notice: "Pick a storage location first." };
    }
    if (!request.ui.moveQtyDraft) return { notice: "Enter a quantity first." };
    const qtyCheck = parseQuantityRepeat(request.ui.moveQtyDraft);
    if (!qtyCheck.ok) return { notice: qtyCheck.notice };
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
    const hasPlantStep = Object.values(wf.nodes).some(
      (n) =>
        n.kind === "pick_plant" &&
        movementBranches(wf).some(
          (m) => m.movementCode === request.ui.moveTypeCode && branchContains(wf, m.id, n.id)
        )
    );
    if (hasPlantStep && !request.ui.movePlantId) {
      return { notice: "Pick a plant first." };
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
    if (request.ui.moveTypeCode === BORROW_MOVEMENT_CODE) {
      if (!request.ui.moveMaintenanceUserId) return { notice: "Pick the maintenance user first." };
      if (!request.ui.moveBorrowerName) return { notice: "Say who is borrowing it — Himself or Other." };
    }
    const typeForCart = request.ui.moveTypeCode
      ? (await loadManualTypes(db, request.chatId)).find((t) => t.code === request.ui.moveTypeCode)
      : null;
    const branchHasReference = Object.values(wf.nodes).some(
      (n) =>
        n.kind === "reference" &&
        movementBranches(wf).some(
          (m) => m.movementCode === request.ui.moveTypeCode && branchContains(wf, m.id, n.id)
        )
    );
    if (
      branchHasReference &&
      typeForCart?.requireReference &&
      !String(request.ui.moveReference ?? "").trim()
    ) {
      return { notice: "A reference is required for this movement." };
    }
    return { addToCart: true };
  }
  if (data === "rq:mv:rec") return { render: await startConfiguredFlow(db, request) };

  // Movement type pick → enter that movement's branch tree
  if (data.startsWith("rq:mv:t:")) {
    const idx = Number(data.slice("rq:mv:t:".length));
    const branches = movementBranches(wf);
    const types = await loadManualTypes(db, request.chatId);
    const byCode = new Map(types.map((t) => [t.code, t]));
    const ordered = branches.length
      ? branches.map((b) => byCode.get(b.movementCode || "")).filter((t): t is MovementType => Boolean(t))
      : types;
    const picked = ordered[idx];
    if (!picked) return { notice: "That movement is no longer available." };
    request.ui.moveTypeCode = picked.code;
    request.ui.moveVendorQuery = "";
    request.ui.movePlantQuery = "";
    request.ui.moveFromLocationId = null;
    request.ui.moveToLocationId = null;
    request.ui.moveLocationId = null;
    request.ui.moveMaintenanceUserId = null;
    request.ui.moveMaintenanceUserName = null;
    request.ui.moveBorrowerId = null;
    request.ui.moveBorrowerName = null;
    request.ui.moveBorrowerSelf = null;
    request.ui.borrowChoiceStage = null;
    const entered = enterMovementBranch(wf, picked.code);
    if (entered) {
      request.ui.flowNodeId = entered;
      return { render: await renderMoveFlow(db, request) };
    }
    return { render: await advance(db, request) };
  }

  // Vendor Master pick (indices match the filtered Vendor Master list on screen)
  if (data.startsWith("rq:mv:vendor:")) {
    const idx = Number(data.slice("rq:mv:vendor:".length));
    const vendors = await activeVendors(db);
    const q = String(request.ui.moveVendorQuery ?? "")
      .trim()
      .toLowerCase();
    const filtered = q
      ? vendors.filter((v) => {
          const hay = [v.name, v.code, v.contact, v.phone, v.email]
            .map((x) => String(x ?? "").toLowerCase())
            .join(" ");
          return hay.includes(q);
        })
      : vendors;
    const v = filtered[idx];
    if (!v) return { notice: "That vendor is no longer available." };
    request.ui.moveVendorId = v._id.toString();
    request.ui.moveVendorName = String(v.name ?? "");
    request.ui.moveVendorQuery = "";
    return { render: await advance(db, request) };
  }

  if (data === "rq:mv:vendorclear") {
    request.ui.moveVendorQuery = "";
    return { render: await renderMoveFlow(db, request) };
  }

  // Plant Master pick
  if (data.startsWith("rq:mv:plant:")) {
    const idx = Number(data.slice("rq:mv:plant:".length));
    const plants = await activePlants(db);
    const q = String(request.ui.movePlantQuery ?? "")
      .trim()
      .toLowerCase();
    const filtered = q
      ? plants.filter((p) => {
          const hay = [p.name, p.code, p.contact].map((x) => String(x ?? "").toLowerCase()).join(" ");
          return hay.includes(q);
        })
      : plants;
    const p = filtered[idx];
    if (!p) return { notice: "That plant is no longer available." };
    request.ui.movePlantId = p._id.toString();
    request.ui.movePlantName = String(p.name ?? "");
    request.ui.movePlantQuery = "";
    return { render: await advance(db, request) };
  }

  if (data === "rq:mv:plantclear") {
    request.ui.movePlantQuery = "";
    return { render: await renderMoveFlow(db, request) };
  }

  // Flat location pick (New Purchase / Return from Plant / Move Stock)
  if (data.startsWith("rq:mv:flat:")) {
    const idx = Number(data.slice("rq:mv:flat:".length));
    let options = await flatSelectableLocations(db);
    if (node?.kind === "to" && request.ui.moveFromLocationId) {
      options = options.filter((o) => o.id !== request.ui.moveFromLocationId);
    }
    const opt = options[idx];
    if (!opt) return { notice: "That location is no longer available." };
    if (node?.kind === "from") {
      request.ui.moveFromLocationId = opt.id;
      request.ui.moveLocationId = opt.id;
      request.ui.focusLocationId = opt.id;
    } else if (node?.kind === "to") {
      if (request.ui.moveFromLocationId && opt.id === request.ui.moveFromLocationId) {
        return { notice: "Source and destination must be different." };
      }
      request.ui.moveToLocationId = opt.id;
    } else {
      request.ui.moveLocationId = opt.id;
      request.ui.focusLocationId = opt.id;
      request.ui.intentLocationPicked = true;
    }
    request.ui.locCursor = null;
    request.ui.locStack = [];
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

  // Maintenance User Master pick — whose account the borrowing sits under.
  if (data.startsWith("rq:mv:mu:")) {
    const idx = Number(data.slice("rq:mv:mu:".length));
    const users = await activeMaintenanceUsers(db);
    const u = users[idx];
    if (!u) return { notice: "That maintenance user is no longer available." };
    request.ui.moveMaintenanceUserId = u._id.toString();
    request.ui.moveMaintenanceUserName = String(u.name ?? "");
    // Changing the account holder invalidates a Himself answer that named the
    // previous one, so the borrower question starts again.
    request.ui.moveBorrowerId = null;
    request.ui.moveBorrowerName = null;
    request.ui.moveBorrowerSelf = null;
    request.ui.borrowChoiceStage = "who";
    return { render: await advance(db, request) };
  }

  // Himself: the borrowing sits under the maintenance user AND they took it.
  if (data === "rq:mv:bself") {
    const owner = request.ui.moveMaintenanceUserName;
    if (!owner) return { notice: "Pick the maintenance user first." };
    request.ui.moveBorrowerId = request.ui.moveMaintenanceUserId ?? null;
    request.ui.moveBorrowerName = owner;
    request.ui.moveBorrowerSelf = true;
    request.ui.borrowChoiceStage = "who";
    return { render: await advance(db, request) };
  }

  // Other: same account, different pair of hands — open the worker list.
  if (data === "rq:mv:bother") {
    if (!request.ui.moveMaintenanceUserName) return { notice: "Pick the maintenance user first." };
    request.ui.borrowChoiceStage = "worker";
    return { render: await renderMoveFlow(db, request) };
  }

  // Back out of the worker list to Himself / Other without leaving the step.
  if (data === "rq:mv:bwho") {
    request.ui.borrowChoiceStage = "who";
    return { render: await renderMoveFlow(db, request) };
  }

  if (data.startsWith("rq:mv:bw:")) {
    const idx = Number(data.slice("rq:mv:bw:".length));
    const workers = await activeWorkers(db);
    const w = workers[idx];
    if (!w) return { notice: "That worker is no longer available." };
    request.ui.moveBorrowerId = w._id.toString();
    request.ui.moveBorrowerName = String(w.name ?? "");
    request.ui.moveBorrowerSelf = false;
    request.ui.borrowChoiceStage = "who";
    return { render: await advance(db, request) };
  }

  // Stock-line location pick
  if (data.startsWith("rq:mv:sl:")) {
    const idx = Number(data.slice("rq:mv:sl:".length));
    const line = hit?.lines[idx];
    if (!line) return { notice: "That location is gone." };
    if (node?.kind === "from") {
      request.ui.moveFromLocationId = line.locationId;
      request.ui.moveLocationId = line.locationId;
      request.ui.focusLocationId = line.locationId;
    } else if (node?.kind === "to") {
      if (request.ui.moveFromLocationId && line.locationId === request.ui.moveFromLocationId) {
        return { notice: "Source and destination must be different." };
      }
      request.ui.moveToLocationId = line.locationId;
    } else {
      request.ui.moveLocationId = line.locationId;
      request.ui.focusLocationId = line.locationId;
      request.ui.intentLocationPicked = true;
    }
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
    let kids = await locationChildren(db, request.ui.locCursor ?? null);
    if (node?.kind === "to" && request.ui.moveFromLocationId) {
      kids = kids.filter((l) => l._id.toString() !== request.ui.moveFromLocationId);
    }
    const loc = kids[idx];
    if (!loc) return { notice: "That location is gone." };
    const locId = loc._id.toString();
    if (drill) {
      request.ui.locStack = [...(request.ui.locStack ?? []), request.ui.locCursor ?? ""].filter((x) => x !== undefined);
      // store previous cursor
      const stack = [...(request.ui.locStack ?? [])];
      if (request.ui.locCursor) stack.push(request.ui.locCursor);
      request.ui.locStack = stack;
      request.ui.locCursor = locId;
      return { render: await renderMoveFlow(db, request) };
    }
    if (node?.kind === "from") request.ui.moveFromLocationId = locId;
    else if (node?.kind === "to") {
      if (request.ui.moveFromLocationId && locId === request.ui.moveFromLocationId) {
        return { notice: "Source and destination must be different." };
      }
      request.ui.moveToLocationId = locId;
    } else {
      request.ui.moveLocationId = locId;
      request.ui.focusLocationId = locId;
      request.ui.intentLocationPicked = true;
    }
    request.ui.locCursor = null;
    request.ui.locStack = [];
    return { render: await advance(db, request) };
  }

  // Qty pad — supports optional × times on the same draft (200 × 5).
  if (data.startsWith("rq:mv:q:")) {
    const pressed = data.slice("rq:mv:q:".length);
    let draft = request.ui.moveQtyDraft ?? "";
    if (pressed === "ok") {
      const parsed = parseQuantityRepeat(draft);
      if (!parsed.ok) return { notice: parsed.notice };
      request.ui.moveQtyDraft = parsed.value.display;

      const locationId = request.ui.moveLocationId || request.ui.focusLocationId || request.ui.moveFromLocationId;
      const hit = await focusedProduct(db, request);
      const moveCode = request.ui.moveTypeCode || undefined;
      const type = moveCode
        ? (await loadManualTypes(db, request.chatId)).find((t) => t.code === moveCode) ?? null
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

      const qty = parsed.value.qty;
      const times = parsed.value.times;
      const totalRequested = qty * times;

      if (!inbound && hit && locationId) {
        const locationPath = await locationPathById(db, locationId);
        const shortage = await findOutboundShortage(db, {
          productId: hit.productId,
          productName: hit.name,
          productNumber: hit.productNumber,
          locationId,
          locationPath: locationPath || "(unknown location)",
          unit: hit.unit,
          qty: totalRequested,
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
            `Out of stock at qty: ${hit.name} — requested ${money(totalRequested)} ${hit.unit}` +
              (times > 1 ? ` (${money(qty)} × ${times} entries)` : "") +
              `, available ${money(shortage.available)}.`
          );
          return {
            render: {
              text: [
                `⚠️ <b>Out of stock</b>`,
                "",
                type ? `<b>${esc(type.name)}</b>` : "",
                `Item: ${esc(shortage.productName)}`,
                `Location: ${esc(shortage.locationPath)}`,
                `Requested: ${money(shortage.qtyRequested)} ${esc(shortage.unit)}` +
                  (times > 1 ? ` (${money(qty)} × ${times} entries)` : ""),
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

    const next = pressQuantityKey(draft, pressed);
    if (next.notice) return { notice: next.notice };
    request.ui.moveQtyDraft = next.value;
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
  const wf = await loadWorkflow(db, request.chatId);
  const node = currentNode(wf, request);
  if (!node) return null;

  if (node.kind === "pick_vendor") {
    request.ui.moveVendorQuery = text.slice(0, 60);
    return { render: await renderMoveFlow(db, request) };
  }
  if (node.kind === "pick_plant") {
    request.ui.movePlantQuery = text.slice(0, 60);
    return { render: await renderMoveFlow(db, request) };
  }
  if (node.kind === "qty") {
    const parsed = parseQuantityRepeat(text);
    if (!parsed.ok) return { notice: parsed.notice };
    request.ui.moveQtyDraft = parsed.value.display;
    return { render: await advance(db, request) };
  }
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
      ? (await loadManualTypes(db, request.chatId)).find((t) => t.code === request.ui.moveTypeCode)
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
