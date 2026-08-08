import { ObjectId, type Db, type Document } from "mongodb";
import {
  aiConfigured,
  identifyItemFromImage,
  expandReferenceNames,
  localReferenceExpansions,
  suggestCategoryForProduct,
  fixProductName,
} from "./ai";
import { logAudit } from "./audit";
import { cached, invalidateCollection } from "./cache";
import { defer } from "./defer";
import {
  activeLocations,
  locationChildren,
  locationParentIds,
  locationPathById,
} from "./locations";
import {
  activeRootCategories,
  activeCategoryChildrenByParentName,
  activeCategories as allActiveCategories,
  categoryAncestorChain,
  categoryChildren,
  categoryParentIds,
  categoryPathFrom,
  categoriesById,
  matchCategory,
} from "./categories";
import { isDuplicateKeyError } from "./mongodb";
import {
  activeOptionTrees,
  findTreeByName,
  matchOptionTree,
  optionNodeChildren,
  treeLevels,
  type OptionLevel,
} from "./option-trees";
import { findAlias, upsertAliases } from "./product-aliases";
import { aliasesByProductId, productMatchesFuzzy, rankItemSuggestions, type MatchCandidate } from "./product-match";
import { activeProducts, ensureProductForEntry, findActiveProductByName } from "./product-store";
import { attributeValues, productLabel, type ProductAttribute } from "./products";
import { receiptKey, recordMovement } from "./stock";
import { buttonRows, downloadFileBytes, sendMessage, type InlineKeyboard } from "./telegram";
import { nextTicketNumber } from "./ticket";
import type { Answer, BotSession, CategoryCursor, NestedCursor, ProductSnapshot, StepInstance } from "./workflow-types";

export type RenderResult = { text: string; keyboard: InlineKeyboard };
export type EngineResult = {
  render?: RenderResult;
  finished?: boolean;
  cancelled?: boolean;
  notice?: string; // short toast for answerCallbackQuery / a nudge reply
};

// ---------------------------------------------------------------------------
// Master-data readers (deterministic ordering so callback indices are stable)
//
// Each collection is read whole, ONCE, and cached; the per-parent slices are then
// filtered in memory. `Array.filter` is stable, so a filtered slice is in exactly
// the order Mongo returned — the callback indices these lists produce are
// identical to what the per-parent queries used to give.
// ---------------------------------------------------------------------------
async function activeCategories(db: Db) {
  // Bot category_select shows roots only; nested nodes are picked via subcategory_select
  // or the full category_tree step.
  return activeRootCategories(db);
}

async function activeSubcategories(db: Db, parentName?: string) {
  return activeCategoryChildrenByParentName(db, parentName);
}

async function activeUnits(db: Db) {
  return cached("units:active", () =>
    db.collection("units").find({ status: "Active" }).sort({ name: 1 }).toArray()
  );
}

// ---------------------------------------------------------------------------
// Category tree (Categories master — Material → Type → Class → Size …)
//
// One step walks the same tree the console Categories screen edits. Typing
// "pipe" opens under Pipe and shows every child; each tap drills one level
// until a leaf is chosen. Unlike nested_select, there is no separate option
// tree — the category adjacency list IS the drill-down.
// ---------------------------------------------------------------------------
function emptyCategoryCursor(): CategoryCursor {
  return { parentStack: [], currentParent: null, matchedId: null };
}

function categoryCursorOf(session: BotSession): CategoryCursor {
  return (session.categoryCursor ??= emptyCategoryCursor());
}

async function categoryOptions(db: Db, session: BotSession) {
  return categoryChildren(db, categoryCursorOf(session).currentParent);
}

// Open the step under the category the item name matches (Pipe for "pipe"),
// or at the roots when nothing matches and the author chose to ask.
async function primeCategoryTree(db: Db, session: BotSession, step: StepInstance): Promise<"ok" | "skip"> {
  const cursor = emptyCategoryCursor();
  session.categoryCursor = cursor;

  if (step.config.matchItem === false) return "ok";

  const all = await allActiveCategories(db);
  const matched = matchCategory(all, itemNameForTree(session));
  if (matched) {
    cursor.currentParent = matched._id.toString();
    cursor.matchedId = cursor.currentParent;
    return "ok";
  }

  if (String(step.config.whenUnmatched ?? "ask") === "skip") return "skip";
  return "ok";
}

function categoryLevelLabel(children: Document[], fallback = "category"): string {
  for (const c of children) {
    const level = String(c.level ?? "").trim();
    if (level) return level;
  }
  return fallback;
}

async function selectCategory(
  db: Db,
  session: BotSession,
  step: StepInstance,
  id: string
): Promise<EngineResult> {
  const byId = await categoriesById(db);
  const chain = categoryAncestorChain(byId, id);
  const path = chain.map((node) => ({
    label: String(node.level ?? "").trim() || "Category",
    value: String(node.name ?? ""),
  }));
  const leaf = byId.get(id);
  // Carry default unit from the leaf (or nearest ancestor) so unit_select can
  // still be skipped later if the workflow wants to prefer the category's unit.
  const unitFromTree =
    [...chain].reverse().map((n) => String(n.defaultUnit ?? "").trim()).find(Boolean) || "";

  session.answers[step.instanceId] = {
    type: "category_tree",
    value: id,
    display: categoryPathFrom(byId, id) || String(leaf?.name ?? id),
    path,
    ...(unitFromTree ? { tree: unitFromTree } : {}),
  };
  session.categoryCursor = emptyCategoryCursor();
  return advance(db, session);
}

// ---------------------------------------------------------------------------
// Product Master
//
// A catalogue is the one master that can outgrow a single inline keyboard, so
// the step pages through it and accepts a typed search. Both the rendered page
// and the tap that comes back resolve through `productOptions`, so the callback
// index can never mean a different product than the button the user saw.
// ---------------------------------------------------------------------------
const PRODUCT_PAGE_SIZE = 8;

async function productOptions(db: Db, session: BotSession, step: StepInstance): Promise<Document[]> {
  const all = await activeProducts(db);
  const category = step.config.filterByCategory ? categoryFilterValue(session) : undefined;
  const scoped = category ? all.filter((p) => String(p.category ?? "") === String(category)) : all;
  const query = session.productQuery ?? "";
  if (!query) return scoped;
  const aliasMap = await aliasesByProductId(db);
  return scoped.filter((p) => productMatchesFuzzy(p, query, aliasMap.get(p._id.toString()) || []));
}

function categoryFilterValue(session: BotSession): string | undefined {
  const flat = answerValue(session, "category_select");
  if (flat !== undefined && flat !== "") return String(flat);
  const path = answerFor(session, "category_tree")?.path;
  if (path?.length) return path[0].value;
  return undefined;
}

function productAttributes(p: Document): ProductAttribute[] {
  if (!Array.isArray(p.attributes)) return [];
  return p.attributes
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
    .map((a) => ({ name: String(a.name ?? ""), value: String(a.value ?? "") }))
    .filter((a) => a.name && a.value);
}

// Copied onto the answer so the entry keeps what was true when it was raised.
function productSnapshot(p: Document): ProductSnapshot {
  return {
    id: p._id.toString(),
    name: String(p.name ?? ""),
    productNumber: String(p.productNumber ?? ""),
    category: String(p.category ?? ""),
    subcategory: String(p.subcategory ?? ""),
    unit: String(p.unit ?? ""),
    attributes: productAttributes(p),
  };
}

// Products differ from each other in their attributes as often as in their
// names ("MS Round Pipe" twice, 50 mm and 80 mm), so the distinguishing values
// go on the button. Telegram truncates long labels mid-word, so we do it first.
function productButtonText(p: Document): string {
  const values = attributeValues(productAttributes(p), 2);
  const text = values ? `${p.name} · ${values}` : String(p.name ?? "");
  return text.length > 42 ? `${text.slice(0, 41)}…` : text;
}

// The node a location step opens inside, from `config.defaultLocation` (a name).
async function defaultLocationNode(db: Db, step: StepInstance) {
  const name = step.config.defaultLocation;
  if (!name) return null;
  const all = await activeLocations(db);
  return all.find((l) => String(l.name) === String(name)) ?? null;
}

// The buttons offered for the current position in the tree — the single source
// of truth for both rendering and resolving a `loc:<i>` tap, so the indices can
// never disagree between the two.
//
// On the landing view (inside the default node, nothing drilled yet) the other
// top-level nodes are appended, so "Others" is reachable without first backing
// out to the root.
async function locationOptions(db: Db, session: BotSession, step: StepInstance) {
  const { currentParent, parentStack } = session.locationCursor;
  const children = await locationChildren(db, currentParent);
  if (!currentParent || parentStack.length) return children;

  const fallback = await defaultLocationNode(db, step);
  if (!fallback || fallback._id.toString() !== currentParent) return children;

  const roots = await locationChildren(db, null);
  return [...children, ...roots.filter((r) => r._id.toString() !== currentParent)];
}

// ---------------------------------------------------------------------------
// Nested option trees
//
// One step, many questions. `nested_select` walks the levels of an option tree
// (lib/option-trees.ts) one at a time — "Type of Wire", then "Subcategory of the
// Wire", then "Colour", then "Size" — so the user answers a short question with
// a keyboard of only the options that are still possible, instead of being asked
// for everything at once.
//
// Which tree it walks is normally worked out from the item the user already
// named, so a single workflow serves every item: "Wire" gets the wire
// questions, "Cement" gets the cement questions, and an item with no tree
// behind it walks straight past the step.
// ---------------------------------------------------------------------------
function emptyNestedCursor(): NestedCursor {
  return { treeId: "", treeName: "", picked: false, level: 0, parentNodeId: null, path: [] };
}

function nestedCursorOf(session: BotSession): NestedCursor {
  return (session.nestedCursor ??= emptyNestedCursor());
}

// What the tree is matched against: whatever the entry has already established
// the item to be. The item step is the usual source; a product step names the
// item just as well when the workflow starts from the catalogue instead.
function itemNameForTree(session: BotSession): string {
  const item = answerFor(session, "item_capture");
  if (item && item.value) return String(item.value);
  const product = answerFor(session, "product_select");
  return String(product?.product?.name ?? product?.display ?? "");
}

// Which tree this step would walk, from its config and the entry's answers
// alone. Deliberately blind to the cursor: it is also the probe for "does this
// step have anything to ask", which has to be answerable while the cursor still
// belongs to the step being left.
async function lookupNestedTree(db: Db, session: BotSession, step: StepInstance): Promise<Document | null> {
  const trees = await activeOptionTrees(db);
  const configured = String(step.config.tree ?? "").trim();
  if (configured) return findTreeByName(trees, configured);
  if (step.config.matchItem === false) return null;
  return matchOptionTree(trees, itemNameForTree(session));
}

// The tree this step is walking, binding it to the cursor the first time it is
// worked out. Precedence: one already chosen for this session, then the lookup.
async function resolveNestedTree(db: Db, session: BotSession, step: StepInstance): Promise<Document | null> {
  const cursor = nestedCursorOf(session);

  if (cursor.treeId) {
    const trees = await activeOptionTrees(db);
    const bound = trees.find((t) => t._id.toString() === cursor.treeId);
    // A tree deactivated mid-entry drops the cursor back to unresolved rather
    // than leaving the step walking a forest that is no longer offered.
    if (bound) return bound;
    session.nestedCursor = emptyNestedCursor();
    return null;
  }

  const found = await lookupNestedTree(db, session, step);
  if (found) bindTree(session, found);
  return found;
}

// Whether a fresh walk of this tree would ask anything at all. A tree whose
// first real level reads from the forest but has no root nodes yet has nothing
// to say, and a step that would show an empty keyboard is worse than one that
// quietly steps aside.
async function treeAsksAnything(db: Db, tree: Document): Promise<boolean> {
  for (const level of treeLevels(tree)) {
    if (level.input === "nodes") {
      const roots = await optionNodeChildren(db, tree._id.toString(), null);
      return roots.length > 0 || Boolean(level.allowOther);
    }
    if (level.input === "list" && !(level.options ?? []).length && !level.allowOther) continue;
    return true;
  }
  return false;
}

// A nested step with nothing to ask for THIS entry: no tree matches the item and
// the author chose to step aside, or the tree that matched is empty. Such a step
// is walked past in both directions, so Back never parks the user on it.
async function nestedNothingToAsk(db: Db, session: BotSession, step: StepInstance | undefined): Promise<boolean> {
  if (step?.type !== "nested_select") return false;
  const tree = await lookupNestedTree(db, session, step);
  if (tree) return !(await treeAsksAnything(db, tree));
  return String(step.config.whenUnmatched ?? "skip") !== "ask";
}

// Entering a nested step: walk to the first level that has a question, which may
// be none at all when the branch bottoms out immediately.
async function enterNested(db: Db, session: BotSession, step: StepInstance): Promise<EngineResult> {
  const tree = await resolveNestedTree(db, session, step);
  // No tree and the author asked for a picker — render it.
  if (!tree) return { render: await renderCurrentStep(db, session) };
  return nestedForward(db, session, step, tree);
}

function bindTree(session: BotSession, tree: Document, picked = false) {
  const cursor = nestedCursorOf(session);
  cursor.treeId = tree._id.toString();
  cursor.treeName = String(tree.name ?? "");
  cursor.picked = picked;
}

// The buttons a level offers — the single source of truth for both rendering it
// and resolving the tap that comes back, so an index can never mean a different
// option than the button the user saw.
async function nestedLevelOptions(db: Db, cursor: NestedCursor, level: OptionLevel): Promise<string[]> {
  if (level.input === "list") return level.options ?? [];
  if (level.input !== "nodes") return [];
  const children = await optionNodeChildren(db, cursor.treeId, cursor.parentNodeId);
  return children.map((n) => String(n.name));
}

function nestedTrail(cursor: NestedCursor): string {
  return cursor.path.map((p) => p.value).join(" › ");
}

// Record one level's answer and move the cursor on. A node answer is the only
// kind that moves the position in the forest.
function pushNestedValue(cursor: NestedCursor, level: OptionLevel, value: string, nodeId?: string) {
  cursor.path.push({ level: cursor.level, label: level.label, value, ...(nodeId ? { nodeId } : {}) });
  if (nodeId) cursor.parentNodeId = nodeId;
  cursor.level += 1;
}

// Walk forward to the next level that actually has something to ask, and finish
// the step when there is nothing left.
//
// A branch is allowed to end above the configured depth: if the tree has no
// children under the node the user picked, there is no honest question to ask,
// so the step commits what it has instead of showing an empty keyboard. That is
// what lets one tree carry "Copper → Flexible → 2.5 sq mm" beside a fibre
// branch that stops at the core count.
async function nestedForward(db: Db, session: BotSession, step: StepInstance, tree: Document): Promise<EngineResult> {
  const cursor = nestedCursorOf(session);
  const levels = treeLevels(tree);

  while (cursor.level < levels.length) {
    const level = levels[cursor.level];
    if (level.input === "nodes") {
      const options = await nestedLevelOptions(db, cursor, level);
      if (options.length || level.allowOther) break;
      cursor.level = levels.length; // nothing below this branch — the walk is done
      break;
    }
    // A list level authored with no options and no typed fallback can never be
    // answered; skipping it beats dead-ending the entry on a config mistake.
    if (level.input === "list" && !(level.options ?? []).length && !level.allowOther) {
      cursor.level += 1;
      continue;
    }
    break;
  }

  if (cursor.level >= levels.length) return commitNested(db, session, step);
  session.numberDraft = "";
  return { render: await renderCurrentStep(db, session) };
}

async function commitNested(db: Db, session: BotSession, step: StepInstance): Promise<EngineResult> {
  const cursor = nestedCursorOf(session);
  if (!cursor.path.length) {
    // Nothing was asked after all (an empty tree, or a first level with no
    // options). Treat it as a step that had nothing to contribute.
    session.answers[step.instanceId] = { type: "nested_select", value: "", display: "(skipped)" };
    return advance(db, session);
  }
  const last = cursor.path[cursor.path.length - 1];
  session.answers[step.instanceId] = {
    type: "nested_select",
    // The deepest node is the durable reference when the walk ended on one; the
    // joined path is what a text-ended walk has to identify it.
    value: last.nodeId ?? nestedTrail(cursor),
    display: nestedTrail(cursor),
    tree: cursor.treeName,
    path: cursor.path.map((p) => ({ label: p.label, value: p.value })),
  };
  return advance(db, session);
}

async function renderNested(db: Db, session: BotSession, step: StepInstance): Promise<RenderResult> {
  const cursor = nestedCursorOf(session);
  const label = step.label || "Tell me more about this item:";
  const tree = await resolveNestedTree(db, session, step);

  // No tree yet — ask which one applies. Reached when nothing matched the item
  // and the step is configured to ask rather than step aside.
  if (!tree) {
    const trees = await activeOptionTrees(db);
    if (!trees.length) {
      return { text: `${escHtml(label)}\n<i>No nested categories are configured yet.</i>`, keyboard: navRow(session) };
    }
    const btns = trees.map((t, i) => ({ text: truncateLabel(String(t.name), 28), callback_data: `nest:tree:${i}` }));
    return {
      text: `${escHtml(label)}\n<i>Which of these is it?</i>`,
      keyboard: [...buttonRows(btns, 2), ...navRow(session)],
    };
  }

  const levels = treeLevels(tree);
  const level = levels[cursor.level];
  if (!level) {
    // Only reachable if the tree was edited mid-entry down to fewer levels.
    return { text: `${escHtml(label)}\n<i>Nothing left to ask here.</i>`, keyboard: navRow(session) };
  }

  const trail = nestedTrail(cursor);
  const heading = [
    `<b>${escHtml(level.label)}</b>`,
    `<i>${escHtml(cursor.treeName)}${trail ? `: ${escHtml(trail)}` : ""}</i>`,
  ];

  if (level.input === "number") {
    return {
      text: `${heading.join("\n")}\n\n${keypadValue(session.numberDraft ?? "", level.min, level.max)}`,
      keyboard: numberPad(session),
    };
  }

  if (level.input === "text") {
    if (level.placeholder) heading.push(`<i>${escHtml(level.placeholder)}</i>`);
    heading.push("", "Type your answer.");
    return { text: heading.join("\n"), keyboard: navRow(session) };
  }

  const options = await nestedLevelOptions(db, cursor, level);
  const prefix = level.input === "list" ? "nest:opt:" : "nest:";
  const btns = options.map((name, i) => ({ text: truncateLabel(name, 28), callback_data: `${prefix}${i}` }));
  if (level.allowOther) {
    heading.push("", options.length ? "Tap an option, or type your own." : "Type your answer.");
  } else if (!options.length) {
    heading.push("", "<i>No options are configured here yet.</i>");
  }
  return { text: heading.join("\n"), keyboard: [...buttonRows(btns, 2), ...navRow(session)] };
}

// A typed answer to the level on screen. Levels that only take taps say so.
async function applyNestedText(db: Db, session: BotSession, step: StepInstance, raw: string): Promise<EngineResult> {
  const cursor = nestedCursorOf(session);
  const tree = await resolveNestedTree(db, session, step);
  if (!tree) return { render: await renderCurrentStep(db, session) };
  const level = treeLevels(tree)[cursor.level];
  if (!level) return { render: await renderCurrentStep(db, session) };

  const text = raw.trim().slice(0, 60);
  if (!text) return { render: await renderCurrentStep(db, session) };

  if (level.input === "number") {
    const check = checkNumber(text, level.min, level.max);
    if (check.notice) return { notice: check.notice };
    pushNestedValue(cursor, level, String(check.value));
    return nestedForward(db, session, step, tree);
  }

  if (level.input === "text" || level.allowOther) {
    // A typed value that names one of this level's own options is that option —
    // typing "Copper" must not fork away from the branch it belongs to.
    if (level.input === "nodes") {
      const children = await optionNodeChildren(db, cursor.treeId, cursor.parentNodeId);
      const hit = children.find((n) => String(n.name).toLowerCase() === text.toLowerCase());
      if (hit) {
        pushNestedValue(cursor, level, String(hit.name), hit._id.toString());
        return nestedForward(db, session, step, tree);
      }
    }
    pushNestedValue(cursor, level, text);
    return nestedForward(db, session, step, tree);
  }

  return { notice: "Pick one of the options above." };
}

async function applyNestedCallback(db: Db, session: BotSession, step: StepInstance, data: string): Promise<EngineResult> {
  const cursor = nestedCursorOf(session);

  if (data.startsWith("nest:tree:")) {
    const trees = await activeOptionTrees(db);
    const chosen = trees[indexOf(data, "nest:tree:")];
    if (!chosen) return { notice: "That option is no longer available." };
    session.nestedCursor = emptyNestedCursor();
    bindTree(session, chosen, true);
    return nestedForward(db, session, step, chosen);
  }

  const tree = await resolveNestedTree(db, session, step);
  if (!tree) return { render: await renderCurrentStep(db, session) };
  const level = treeLevels(tree)[cursor.level];
  if (!level) return { render: await renderCurrentStep(db, session) };

  if (level.input === "number") {
    if (!data.startsWith("num:")) return { notice: "Use the keypad above." };
    const pressed = data.slice(4);
    if (pressed === "ok") {
      const check = checkNumber(session.numberDraft ?? "", level.min, level.max);
      if (check.notice) return { notice: check.notice };
      pushNestedValue(cursor, level, String(check.value));
      return nestedForward(db, session, step, tree);
    }
    const draft = pressKeypad(session.numberDraft ?? "", pressed);
    if (draft.notice) return { notice: draft.notice };
    session.numberDraft = draft.value;
    return { render: await renderCurrentStep(db, session) };
  }

  if (level.input === "list") {
    const chosen = (level.options ?? [])[indexOf(data, "nest:opt:")];
    if (!data.startsWith("nest:opt:") || chosen === undefined) return { notice: "Pick one of the options above." };
    pushNestedValue(cursor, level, chosen);
    return nestedForward(db, session, step, tree);
  }

  if (!data.startsWith("nest:")) return { notice: "Pick one of the options above." };
  const children = await optionNodeChildren(db, cursor.treeId, cursor.parentNodeId);
  const chosen = children[indexOf(data, "nest:")];
  if (!chosen) return { notice: "That option is no longer available." };
  pushNestedValue(cursor, level, String(chosen.name), chosen._id.toString());
  return nestedForward(db, session, step, tree);
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------
function currentStep(session: BotSession): StepInstance {
  return session.steps[session.stepIndex];
}

function canGoBack(session: BotSession): boolean {
  const step = currentStep(session);
  if (step?.type === "location_tree" && session.locationCursor.currentParent !== null) return true;
  if (step?.type === "category_tree" && categoryCursorOf(session).currentParent !== null) return true;
  // Inside a nested step, Back undoes the last level answered — and the tree
  // choice itself when the user was the one who made it.
  if (step?.type === "nested_select" && session.nestedCursor) {
    const c = session.nestedCursor;
    if (c.path.length || (c.picked && c.treeId)) return true;
  }
  return session.stepIndex > 0;
}

// ---------------------------------------------------------------------------
// Number keypad
//
// Numbers are entered on an inline keypad rather than by typing a message.
// Telegram gives bots no native numeric input dialog, and a typed answer is a
// second chat message — which is exactly what the single-anchor-message design
// exists to avoid. Taps are callbacks, so every digit edits the anchor in place
// and the group sees one message for the whole entry.
// ---------------------------------------------------------------------------
// The draft is echoed so the user can see what they've keyed before committing.
// Split out from the step's own prompt because a nested step's number level
// draws the same keypad under a level label rather than a step label.
function keypadValue(draft: string, min = 0, max = 0): string {
  const hint = min && max ? `Allowed: ${min}–${max}` : min ? `Minimum: ${min}` : max ? `Maximum: ${max}` : "";
  return `<b>${draft || "—"}</b>${hint ? `\n<i>${hint}</i>` : ""}`;
}

function numberPadText(step: StepInstance, draft: string): string {
  const label = step.label || step.type;
  return `${label}\n\n${keypadValue(draft, Number(step.config.numberMin) || 0, Number(step.config.numberMax) || 0)}`;
}

function numberPad(session: BotSession): InlineKeyboard {
  const key = (d: string) => ({ text: d, callback_data: `num:${d}` });
  return [
    ["1", "2", "3"].map(key),
    ["4", "5", "6"].map(key),
    ["7", "8", "9"].map(key),
    // The decimal point keeps fractional quantities (1.5 kg) enterable — typing
    // used to allow them, so the keypad has to as well.
    [key("."), key("0"), { text: "⌫", callback_data: "num:del" }],
    [{ text: "✔ Done", callback_data: "num:ok" }],
    ...navRow(session),
  ];
}

// One definition of what counts as a valid number answer, shared by number
// steps and the number levels of a nested step.
function checkNumber(raw: string, min = 0, max = 0): { value?: number; notice?: string } {
  const text = raw.trim();
  if (!text) return { notice: "Enter a number first." };
  const n = Number(text);
  if (!Number.isFinite(n)) return { notice: "That isn't a valid number." };
  if (min && n < min) return { notice: `Must be at least ${min}.` };
  if (max && n > max) return { notice: `Must be at most ${max}.` };
  return { value: n };
}

// One keypad press applied to the draft. Returns the new draft, or a notice when
// the press cannot be honoured.
function pressKeypad(draft: string, pressed: string): { value: string; notice?: string } {
  if (pressed === "del") return { value: draft.slice(0, -1) };
  if (pressed === ".") {
    if (draft.includes(".")) return { value: draft, notice: "Only one decimal point." };
    return { value: draft === "" ? "0." : `${draft}.` };
  }
  // A 15-digit quantity is a mis-tap, not an entry, and the draft has to stay
  // well inside Telegram's message limits.
  if (draft.replace(".", "").length >= 12) return { value: draft, notice: "That's as long as a number can get." };
  // Keeps a leading tap of 0 from turning 5 into "05".
  return { value: draft === "0" ? pressed : draft + pressed };
}

// Validate and record a number answer. The keypad's Done key is the only caller
// today.
async function commitNumber(db: Db, session: BotSession, step: StepInstance, raw: string): Promise<EngineResult> {
  const check = checkNumber(raw, Number(step.config.numberMin) || 0, Number(step.config.numberMax) || 0);
  if (check.notice) return { notice: check.notice };
  session.answers[step.instanceId] = { type: step.type, value: check.value as number, display: String(check.value) };
  session.numberDraft = "";
  return advance(db, session);
}

// Standard footer: [Back?] [Skip?] [Cancel]
// Steps that a Skip button must never appear on, however they were configured.
// An approval marked optional in the builder would otherwise let the submitter
// skip their own approval; a review step has its own Confirm.
const UNSKIPPABLE: ReadonlySet<string> = new Set(["approval", "review_confirm"]);

function navRow(session: BotSession): InlineKeyboard {
  const step = currentStep(session);
  const row = [];
  if (canGoBack(session)) row.push({ text: "⬅ Back", callback_data: "cb:back" });
  if (step && !step.required && !UNSKIPPABLE.has(step.type)) row.push({ text: "Skip ⤼", callback_data: "cb:skip" });
  row.push({ text: "✖ Cancel", callback_data: "cb:cancel" });
  return [row];
}

function escHtml(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateLabel(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function renderItemSuggest(session: BotSession, step: StepInstance): RenderResult {
  const suggest = session.itemSuggest!;
  const top = suggest.candidates[0]?.name || suggest.labels[0] || "";
  const lines = [`<b>${escHtml(step.label || "Item")}</b>`, ""];
  if (suggest.imageFileId) lines.push("📷 Photo received");
  if (top) lines.push(`Looks like: <b>${escHtml(top)}</b>`);
  if (suggest.labels.length > 1) {
    lines.push(`Also: ${suggest.labels.slice(0, 6).map(escHtml).join(", ")}`);
  }
  if (suggest.typed) lines.push(`You typed: <i>${escHtml(suggest.typed)}</i>`);
  lines.push("", "Tap a recommendation:");

  const btns = suggest.candidates.map((c, i) => ({
    text: i === 0 ? `✔ ${truncateLabel(c.name, 26)}` : truncateLabel(c.name, 28),
    callback_data: `ai:pick:${i}`,
  }));
  const rows: InlineKeyboard = buttonRows(btns, 1);
  if (suggest.typed) {
    rows.push([{ text: `Use “${truncateLabel(suggest.typed, 22)}” as typed`, callback_data: "ai:as:typed" }]);
  }
  if (suggest.labels[0] && !suggest.candidates.some((c) => c.name.toLowerCase() === suggest.labels[0].toLowerCase())) {
    rows.push([{ text: `Use “${truncateLabel(suggest.labels[0], 22)}”`, callback_data: "ai:as:label" }]);
  }
  return { text: lines.join("\n"), keyboard: [...rows, ...navRow(session)] };
}

async function presentItemSuggestions(
  db: Db,
  session: BotSession,
  step: StepInstance,
  opts: { typed?: string; labels?: string[]; imageFileId?: string; forceSuggest?: boolean }
): Promise<EngineResult> {
  let candidates = await rankItemSuggestions(db, {
    typed: opts.typed,
    labels: opts.labels,
    limit: 5,
  });

  // Exact product name typed → skip the picker (never for photo-driven / AI flow).
  // Typed & caption paths never call AI here — use the worker's wording as entered.
  if (!opts.forceSuggest && opts.typed) {
    if (candidates[0]?.score >= 100 && candidates[0].source === "exact") {
      return commitItemName(db, session, step, {
        name: candidates[0].name,
        productId: candidates[0].productId,
        imageFileId: opts.imageFileId || session.answers[step.instanceId]?.imageFileId,
        aliases: [...(opts.labels ?? []), opts.typed],
      });
    }
    return commitItemName(db, session, step, {
      name: opts.typed,
      imageFileId: opts.imageFileId || session.answers[step.instanceId]?.imageFileId,
      aliases: opts.labels ?? [],
    });
  }

  // Ensure AI labels always appear as tappable recommendations.
  if (opts.labels?.length) {
    for (const label of opts.labels) {
      if (!candidates.some((c) => c.name.toLowerCase() === label.toLowerCase())) {
        candidates.push({ name: label, score: 50, source: "ai" });
      }
    }
    candidates = candidates.slice(0, 6);
  }

  if (!candidates.length) {
    const fallbackName = opts.typed || opts.labels?.[0] || "";
    if (!fallbackName) {
      return {
        render: {
          text: `${step.label || "Item"}\n\n📷 Could not identify. Type the item name.`,
          keyboard: navRow(session),
        },
      };
    }
    // Photo path always asks the user to confirm; typed-only may still commit.
    if (opts.forceSuggest) {
      candidates = [{ name: fallbackName, score: 40, source: "ai" }];
    } else {
      return commitItemName(db, session, step, {
        name: fallbackName,
        imageFileId: opts.imageFileId || session.answers[step.instanceId]?.imageFileId,
        aliases: opts.labels ?? [],
      });
    }
  }

  session.itemSuggest = {
    awaiting: true,
    typed: opts.typed,
    labels: opts.labels ?? [],
    imageFileId: opts.imageFileId || session.answers[step.instanceId]?.imageFileId,
    candidates: candidates.map((c: MatchCandidate) => ({
      name: c.name,
      productId: c.productId,
      productNumber: c.productNumber,
      score: c.score,
      source: c.source,
    })),
  };

  if (opts.imageFileId) {
    const prev = session.answers[step.instanceId];
    session.answers[step.instanceId] = {
      type: "item_capture",
      value: prev?.value ?? "",
      display: String(prev?.display || "(image)"),
      imageFileId: opts.imageFileId,
    };
  }

  return { render: renderItemSuggest(session, step) };
}

async function handleItemCaptureInput(
  db: Db,
  session: BotSession,
  step: StepInstance,
  input: { text?: string; imageFileId?: string }
): Promise<EngineResult> {
  const name = (input.text ?? "").trim().slice(0, 80);
  const image = input.imageFileId;
  const priorImage = session.answers[step.instanceId]?.imageFileId;

  if (step.config.requireImage && !image && !priorImage) {
    return { notice: "Please send a photo of the item." };
  }
  if (!name && !image && !session.answers[step.instanceId] && !session.itemSuggest?.awaiting) {
    return { notice: "Send a photo or type the item name." };
  }

  // Photo + text/caption: never call vision — keep the worker's wording.
  if (image && name) {
    return presentItemSuggestions(db, session, step, {
      typed: name,
      imageFileId: image,
    });
  }

  // Image-only: download + vision, then suggest.
  if (image) {
    if (!aiConfigured()) {
      // No AI key — keep photo and wait for a typed name.
      session.answers[step.instanceId] = {
        type: "item_capture",
        value: session.answers[step.instanceId]?.value || "",
        display: String(session.answers[step.instanceId]?.value || "(image)"),
        imageFileId: image,
      };
      return {
        render: {
          text: `${step.label || "Item"}\n\n📷 Photo saved. Type the item name.`,
          keyboard: navRow(session),
        },
      };
    }

    let labels: string[] = [];
    let visionError = "";
    try {
      const file = await downloadFileBytes(image);
      if (file) {
        console.log(`[ai] vision start bytes=${file.bytes.length} mime=${file.mime}`);
        labels = await identifyItemFromImage(file.bytes, file.mime);
        console.log(`[ai] vision labels=${JSON.stringify(labels)}`);
      } else if (/^(1|true|yes)$/i.test(process.env.AI_MOCK || "")) {
        labels = await identifyItemFromImage(Buffer.from([]), "image/jpeg");
      } else {
        visionError = "could not download photo from Telegram";
      }
    } catch (err) {
      visionError = err instanceof Error ? err.message : String(err);
      console.error("[ai] identifyItemFromImage failed:", err);
    }

    if (!labels.length) {
      session.answers[step.instanceId] = {
        type: "item_capture",
        value: "",
        display: "(image)",
        imageFileId: image,
      };
      const hint = visionError
        ? `\n<i>${escHtml(visionError.slice(0, 160))}</i>`
        : "\n<i>Nemotron returned no product names — try a clearer photo or type the name.</i>";
      return {
        render: {
          text: `${step.label || "Item"}\n\n📷 Photo saved, but Nemotron could not name it.${hint}\n\nType the item name.`,
          keyboard: navRow(session),
        },
      };
    }

    return presentItemSuggestions(db, session, step, {
      labels,
      imageFileId: image,
      forceSuggest: true,
    });
  }

  // Text-only: fuzzy / alias suggestions.
  if (name) {
    return presentItemSuggestions(db, session, step, {
      typed: name,
      imageFileId: priorImage,
    });
  }

  return { render: await renderCurrentStep(db, session) };
}

async function commitItemName(
  db: Db,
  session: BotSession,
  step: StepInstance,
  opts: { name: string; productId?: string; imageFileId?: string; aliases?: string[] }
): Promise<EngineResult> {
  const name = opts.name.trim().slice(0, 80);
  if (!name) return { notice: "Pick or type an item name." };

  let productId = opts.productId;
  let productSnap: ProductSnapshot | undefined;
  if (!productId) {
    const products = await activeProducts(db);
    const hit = products.find((p) => String(p.name ?? "").toLowerCase() === name.toLowerCase());
    if (hit) {
      productId = hit._id.toString();
      productSnap = productSnapshot(hit);
    }
  } else {
    try {
      const p = await db.collection("products").findOne({ _id: new ObjectId(productId) });
      if (p) productSnap = productSnapshot(p);
    } catch {
      /* keep name */
    }
  }

  // If still no product row, link via an existing alias of this spelling.
  if (!productId) {
    const aliased = await findAlias(db, name);
    if (aliased?.productId) {
      productId = aliased.productId;
      try {
        const p = await db.collection("products").findOne({ _id: new ObjectId(productId) });
        if (p) productSnap = productSnapshot(p);
      } catch {
        /* snapshot optional */
      }
    }
  }

  // Fuzzy-link to Product Master so reference tags still land on a real item.
  if (!productId) {
    const ranked = await rankItemSuggestions(db, {
      typed: name,
      labels: opts.aliases,
      limit: 1,
    });
    const top = ranked[0];
    if (top?.productId && top.score >= 55) {
      productId = top.productId;
      try {
        const p = await db.collection("products").findOne({ _id: new ObjectId(productId) });
        if (p) productSnap = productSnapshot(p);
      } catch {
        /* snapshot optional */
      }
    }
  }

  session.answers[step.instanceId] = {
    type: "item_capture",
    value: name,
    display: name,
    imageFileId: opts.imageFileId || session.itemSuggest?.imageFileId || session.answers[step.instanceId]?.imageFileId,
    // Carry the linked Product Master row forward so finalize can post stock
    // without re-resolving when the user picked / matched an existing product.
    ...(productSnap ? { product: productSnap } : {}),
  };
  // Reference-name / category AI runs after submit (see enrichProductAfterSubmit),
  // not mid-conversation — keep capture responsive and honour typed names as-is.
  session.itemSuggest = undefined;

  return advance(db, session);
}

async function commitItemSuggestion(
  db: Db,
  session: BotSession,
  step: StepInstance,
  data: string
): Promise<EngineResult> {
  const suggest = session.itemSuggest;
  if (!suggest?.awaiting) return { notice: "Send a photo or type a name first." };

  if (data === "ai:as:typed") {
    const typed = suggest.typed?.trim();
    if (!typed) return { notice: "Nothing typed to use." };
    return commitItemName(db, session, step, {
      name: typed,
      imageFileId: suggest.imageFileId,
      aliases: suggest.labels,
    });
  }

  if (data === "ai:as:label") {
    const label = suggest.labels[0]?.trim();
    if (!label) return { notice: "No AI label to use." };
    const hit = suggest.candidates.find((c) => c.name.toLowerCase() === label.toLowerCase());
    return commitItemName(db, session, step, {
      name: label,
      productId: hit?.productId,
      imageFileId: suggest.imageFileId,
      aliases: [...suggest.labels, suggest.typed ?? ""],
    });
  }

  if (data.startsWith("ai:pick:")) {
    const idx = Number(data.slice("ai:pick:".length));
    const chosen = suggest.candidates[idx];
    if (!chosen) return { notice: "That suggestion expired. Send again." };
    return commitItemName(db, session, step, {
      name: chosen.name,
      productId: chosen.productId,
      imageFileId: suggest.imageFileId,
      aliases: [...suggest.labels, suggest.typed ?? "", ...suggest.candidates.map((c) => c.name)],
    });
  }

  return { notice: "Use the buttons above." };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
export async function renderCurrentStep(db: Db, session: BotSession): Promise<RenderResult> {
  const step = currentStep(session);
  if (!step) return { text: "…", keyboard: [] };
  const label = step.label || step.type;

  switch (step.type) {
    case "item_capture": {
      const suggest = session.itemSuggest;
      if (suggest?.awaiting && suggest.candidates.length) {
        return renderItemSuggest(session, step);
      }
      return {
        text: `${label}\n\nSend a <b>photo</b> or type the item name.`,
        keyboard: navRow(session),
      };
    }

    case "product_select": {
      const options = await productOptions(db, session, step);
      const query = session.productQuery ?? "";
      const pageCount = Math.max(1, Math.ceil(options.length / PRODUCT_PAGE_SIZE));
      // Clamp rather than trust: a search that shortened the list can leave the
      // cursor past the end, and an out-of-range page would render nothing.
      const page = Math.min(Math.max(session.productPage ?? 0, 0), pageCount - 1);
      session.productPage = page;
      const start = page * PRODUCT_PAGE_SIZE;
      const slice = options.slice(start, start + PRODUCT_PAGE_SIZE);

      // The callback carries the index into the FULL filtered list, not into the
      // page, so paging can never shift what a button means.
      const btns = slice.map((p, i) => ({ text: productButtonText(p), callback_data: `prod:${start + i}` }));
      const rows: InlineKeyboard = buttonRows(btns, 2);
      const pager = [];
      if (page > 0) pager.push({ text: "◀ Prev", callback_data: "prodpg:prev" });
      if (page < pageCount - 1) pager.push({ text: "Next ▶", callback_data: "prodpg:next" });
      if (query) pager.push({ text: "✖ Clear search", callback_data: "prodclr" });
      if (pager.length) rows.push(pager);

      const lines = [label];
      if (query) lines.push(`<i>Search: “${query}” — ${options.length} match${options.length === 1 ? "" : "es"}</i>`);
      else if (options.length > PRODUCT_PAGE_SIZE) lines.push("<i>Type a name, number or attribute to search.</i>");
      if (!options.length) {
        lines.push(query ? "<i>Nothing matches. Clear the search or type something else.</i>" : "<i>No products available yet.</i>");
      } else if (pageCount > 1) {
        lines.push(`<i>Showing ${start + 1}–${start + slice.length} of ${options.length}</i>`);
      }
      return { text: lines.join("\n"), keyboard: [...rows, ...navRow(session)] };
    }

    case "category_select": {
      const cats = await activeCategories(db);
      const btns = cats.map((c, i) => ({ text: String(c.name), callback_data: `cat:${i}` }));
      return { text: label, keyboard: [...buttonRows(btns, 2), ...navRow(session)] };
    }

    case "subcategory_select": {
      const parent = step.config.filterByCategory ? answerValue(session, "category_select") : undefined;
      const subs = await activeSubcategories(db, parent ? String(parent) : undefined);
      const btns = subs.map((s, i) => ({ text: String(s.name), callback_data: `sub:${i}` }));
      const text = btns.length ? label : `${label}\n<i>No subcategories available.</i>`;
      return { text, keyboard: [...buttonRows(btns, 2), ...navRow(session)] };
    }

    case "category_tree": {
      const cursor = categoryCursorOf(session);
      const [options, parents, byId] = await Promise.all([
        categoryOptions(db, session),
        categoryParentIds(db),
        categoriesById(db),
      ]);
      const here = cursor.currentParent ? categoryPathFrom(byId, cursor.currentParent) : "";
      const levelName = categoryLevelLabel(options, here ? "next" : "category");
      const btns = options.map((c, i) => ({
        text: `${parents.has(c._id.toString()) ? "📁" : "🏷"} ${c.name}`,
        callback_data: `ctree:${i}`,
      }));
      const rows: InlineKeyboard = buttonRows(btns, 2);
      // A branch can be the answer when the branch itself is stockable — rare,
      // but matches location_tree so the user is never stuck without a leaf.
      if (cursor.currentParent !== null) {
        rows.push([{ text: `✔ Select this ${levelName.toLowerCase()}`, callback_data: "ctreesel" }]);
      }
      const heading = here
        ? `${label}\n<b>${escHtml(here)}</b>\n<i>Select ${escHtml(levelName)} — all ${options.length} shown</i>`
        : `${label}\n<i>Select ${escHtml(levelName)} — all ${options.length} shown</i>`;
      const empty = options.length
        ? heading
        : `${heading}\n<i>No categories under here. Use ✔ to select this level, or Back.</i>`;
      return { text: empty, keyboard: [...rows, ...navRow(session)] };
    }

    case "nested_select":
      return renderNested(db, session, step);

    case "location_tree": {
      const cursor = session.locationCursor.currentParent;
      const [options, parents, here] = await Promise.all([
        locationOptions(db, session, step),
        locationParentIds(db),
        cursor ? locationPathById(db, cursor) : Promise.resolve(""),
      ]);
      // 📁 drills in, 📍 selects on tap — the icon tells the user which it is.
      const btns = options.map((c, i) => ({
        text: `${parents.has(c._id.toString()) ? "📁" : "📍"} ${c.name}`,
        callback_data: `loc:${i}`,
      }));
      const rows: InlineKeyboard = buttonRows(btns, 2);
      if (cursor !== null) {
        rows.push([{ text: "✔ Select this location", callback_data: "locsel" }]);
      }
      const text = here ? `${label}\n<i>Current: ${here}</i>` : label;
      return { text, keyboard: [...rows, ...navRow(session)] };
    }

    case "quantity":
    case "custom_number":
      return { text: numberPadText(step, session.numberDraft ?? ""), keyboard: numberPad(session) };

    case "unit_select": {
      const units = await activeUnits(db);
      const btns = units.map((u, i) => ({ text: `${u.name}${u.symbol ? ` (${u.symbol})` : ""}`, callback_data: `unit:${i}` }));
      return { text: label, keyboard: [...buttonRows(btns, 2), ...navRow(session)] };
    }

    case "custom_text":
      return { text: `${label}${step.config.placeholder ? `\n<i>${step.config.placeholder}</i>` : ""}`, keyboard: navRow(session) };

    case "approval":
      return {
        text: `${label}\n\n${summaryText(session)}\n\nApprover role: <b>${step.config.approverRole || "Admin"}</b>`,
        keyboard: [[{ text: "✔ Approve", callback_data: "appr:ok" }, { text: "✖ Reject", callback_data: "appr:no" }], ...navRow(session)],
      };

    case "review_confirm":
      return {
        text: `${label}\n\n${summaryText(session)}`,
        keyboard: [[{ text: "✅ Confirm", callback_data: "confirm" }], ...navRow(session)],
      };

    default:
      return { text: label, keyboard: navRow(session) };
  }
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------
export async function applyMessage(
  db: Db,
  session: BotSession,
  input: { text?: string; imageFileId?: string }
): Promise<EngineResult> {
  const step = currentStep(session);
  if (!step) return { finished: true };

  switch (step.type) {
    case "item_capture": {
      return handleItemCaptureInput(db, session, step, input);
    }

    case "custom_text": {
      const t = (input.text ?? "").trim();
      if (!t) return { notice: "Please send some text." };
      session.answers[step.instanceId] = { type: "custom_text", value: t, display: t };
      return advance(db, session);
    }

    case "nested_select":
      // A typed message answers the level on screen when that level takes typed
      // input; levels that only take taps say so rather than swallowing it.
      return applyNestedText(db, session, step, input.text ?? "");

    case "product_select": {
      // A typed message on a product step is a search, not an answer — the
      // catalogue is too long to be a keyboard on its own.
      const q = (input.text ?? "").trim().slice(0, 60);
      if (!q) return { render: await renderCurrentStep(db, session) };
      const previous = session.productQuery;
      session.productQuery = q;
      session.productPage = 0;
      const matches = await productOptions(db, session, step);
      if (!matches.length) {
        // Keep the list the user could still act on rather than replacing it
        // with an empty one.
        session.productQuery = previous;
        return { notice: `No product matches “${q}”.` };
      }
      return { render: await renderCurrentStep(db, session) };
    }

    default:
      // Button-only step — number steps included, now that they are keypad-driven.
      // A typed message can't answer it, so re-render the step rather than emit a
      // nudge: the webhook redraws the anchor message in place, which leaves the
      // existing prompt and its buttons exactly as they are.
      return { render: await renderCurrentStep(db, session) };
  }
}

export async function applyCallback(db: Db, session: BotSession, data: string): Promise<EngineResult> {
  const step = currentStep(session);
  if (!step) return { finished: true };

  // Status is set here rather than in the webhook's delivery step so that the
  // session snapshot is final before it is written — the write now runs
  // concurrently with the Telegram call.
  if (data === "cb:cancel") {
    session.status = "cancelled";
    return { cancelled: true };
  }
  if (data === "cb:back") return goBack(db, session);
  if (data === "cb:skip") {
    if (step.required) return { notice: "This step is required." };
    // Belt and braces for a stale keyboard from before the rule above existed.
    if (UNSKIPPABLE.has(step.type)) return { notice: "This step can't be skipped." };
    session.answers[step.instanceId] = { type: step.type, value: "", display: "(skipped)" };
    session.itemSuggest = undefined;
    // Skip on a nested step abandons the whole drill-down, not just the level on
    // screen — partial levels would be a half-described item.
    session.nestedCursor = emptyNestedCursor();
    session.categoryCursor = emptyCategoryCursor();
    return advance(db, session);
  }

  // AI / fuzzy item name suggestions (item_capture).
  if (data.startsWith("ai:")) {
    if (step.type !== "item_capture") return { notice: "That button is for the item step." };
    return commitItemSuggestion(db, session, step, data);
  }

  switch (step.type) {
    case "quantity":
    case "custom_number": {
      if (!data.startsWith("num:")) return { notice: "Use the keypad above." };
      const pressed = data.slice(4);
      if (pressed === "ok") return commitNumber(db, session, step, session.numberDraft ?? "");

      const draft = pressKeypad(session.numberDraft ?? "", pressed);
      if (draft.notice) return { notice: draft.notice };
      session.numberDraft = draft.value;
      return { render: await renderCurrentStep(db, session) };
    }

    case "nested_select":
      return applyNestedCallback(db, session, step, data);

    case "product_select": {
      if (data === "prodclr") {
        session.productQuery = "";
        session.productPage = 0;
        return { render: await renderCurrentStep(db, session) };
      }
      if (data.startsWith("prodpg:")) {
        session.productPage = Math.max(0, (session.productPage ?? 0) + (data === "prodpg:next" ? 1 : -1));
        return { render: await renderCurrentStep(db, session) };
      }
      if (!data.startsWith("prod:")) return { notice: "Pick a product from the list." };

      const options = await productOptions(db, session, step);
      const chosen = options[indexOf(data, "prod:")];
      if (!chosen) return { notice: "That product is no longer available." };
      session.answers[step.instanceId] = {
        type: "product_select",
        // The id is the durable reference; the snapshot is what the ticket keeps.
        value: chosen._id.toString(),
        display: productLabel(chosen),
        product: productSnapshot(chosen),
      };
      return advance(db, session);
    }

    case "category_select": {
      const cats = await activeCategories(db);
      const c = cats[indexOf(data, "cat:")];
      if (!c) return { notice: "That option is no longer available." };
      session.answers[step.instanceId] = { type: "category_select", value: String(c.name), display: String(c.name) };
      return advance(db, session);
    }

    case "subcategory_select": {
      const parent = step.config.filterByCategory ? answerValue(session, "category_select") : undefined;
      const subs = await activeSubcategories(db, parent ? String(parent) : undefined);
      const s = subs[indexOf(data, "sub:")];
      if (!s) return { notice: "That option is no longer available." };
      session.answers[step.instanceId] = { type: "subcategory_select", value: String(s.name), display: String(s.name) };
      return advance(db, session);
    }

    case "category_tree": {
      if (data === "ctreesel") {
        const chosen = categoryCursorOf(session).currentParent;
        if (!chosen) return { notice: "Pick a category first." };
        return selectCategory(db, session, step, chosen);
      }

      const options = await categoryOptions(db, session);
      const chosen = options[indexOf(data, "ctree:")];
      if (!chosen) return { notice: "That category is no longer available." };

      const chosenId = chosen._id.toString();
      const parents = await categoryParentIds(db);
      // A leaf can only ever be the answer — selecting it finishes the step.
      if (!parents.has(chosenId)) return selectCategory(db, session, step, chosenId);

      const cursor = categoryCursorOf(session);
      if ((chosen.parent ?? null) === cursor.currentParent) {
        if (cursor.currentParent) cursor.parentStack.push(cursor.currentParent);
      } else {
        cursor.parentStack = [];
      }
      cursor.currentParent = chosenId;
      return { render: await renderCurrentStep(db, session) };
    }

    case "unit_select": {
      const units = await activeUnits(db);
      const u = units[indexOf(data, "unit:")];
      if (!u) return { notice: "That option is no longer available." };
      session.answers[step.instanceId] = { type: "unit_select", value: String(u.name), display: String(u.name) };
      return advance(db, session);
    }

    case "location_tree": {
      if (data === "locsel") {
        const chosen = session.locationCursor.currentParent;
        if (!chosen) return { notice: "Drill into a location first." };
        return selectLocation(db, session, step, chosen);
      }

      const options = await locationOptions(db, session, step);
      const chosen = options[indexOf(data, "loc:")];
      if (!chosen) return { notice: "That location is no longer available." };

      const chosenId = chosen._id.toString();
      const parents = await locationParentIds(db);
      // A node with nothing under it can only ever be the answer, so tapping it
      // selects rather than opening an empty level the user has to confirm.
      if (!parents.has(chosenId)) return selectLocation(db, session, step, chosenId);

      const cursor = session.locationCursor;
      if ((chosen.parent ?? null) === cursor.currentParent) {
        if (cursor.currentParent) cursor.parentStack.push(cursor.currentParent);
      } else {
        // Jumped out of the current branch — this is the landing view's escape to
        // a different top-level node, so the old trail no longer applies.
        cursor.parentStack = [];
      }
      cursor.currentParent = chosenId;
      return { render: await renderCurrentStep(db, session) };
    }

    case "approval": {
      // Authorization of the approver is enforced in the webhook before calling
      // this; here we just record the decision.
      if (data === "appr:no") {
        session.approval = { ...(session.approval ?? { stepInstanceId: step.instanceId, awaitingRole: "" }), decision: "no" };
        session.status = "cancelled";
        return { cancelled: true, notice: "Entry rejected." };
      }
      if (data === "appr:ok") {
        session.approval = { ...(session.approval ?? { stepInstanceId: step.instanceId, awaitingRole: "" }), decision: "ok" };
        session.answers[step.instanceId] = { type: "approval", value: "approved", display: "Approved" };
        session.status = "active";
        return advance(db, session);
      }
      return { notice: "Use the Approve or Reject buttons." };
    }

    case "review_confirm":
      if (data === "confirm") return finalize(db, session);
      return { notice: "Tap Confirm to save." };

    default:
      return { notice: "Please use the buttons above." };
  }
}

function indexOf(data: string, prefix: string): number {
  return parseInt(data.slice(prefix.length), 10);
}

// Record a chosen location and move on. Used by both a tap on a leaf and the
// explicit "Select this location" on a branch.
async function selectLocation(db: Db, session: BotSession, step: StepInstance, id: string): Promise<EngineResult> {
  session.answers[step.instanceId] = {
    type: "location_tree",
    value: id,
    display: await locationPathById(db, id),
  };
  return advance(db, session);
}

// Reset the per-step scratch state for a step that is about to be shown: the
// location cursor and the number keypad's draft. A location step configured with
// a default node opens inside it, so the common case costs one tap instead of
// two; everything else starts at the root as before.
//
// Exported so a session whose FIRST step needs priming is covered too — the
// engine's own entry points (advance/goBack) cover every later step.
export async function primeStep(db: Db, session: BotSession) {
  session.locationCursor = { parentStack: [], currentParent: null };
  // A product step always opens on the unfiltered first page, including when
  // Back returns to it — a stale search from earlier in the entry would hide
  // most of the catalogue with no visible reason.
  session.productQuery = "";
  session.productPage = 0;
  session.itemSuggest = undefined;
  // A nested step always re-opens at the top of its tree: the tree itself is
  // re-resolved from the item, which may have changed since the last visit.
  session.nestedCursor = emptyNestedCursor();
  // Category tree is re-matched from the item name on every entry into the step.
  session.categoryCursor = emptyCategoryCursor();
  const step = currentStep(session);
  if (!step) return;

  // Stepping back INTO a number step reopens the keypad on the value already
  // entered, so Back preserves it the same way it preserves every other answer.
  const prior = session.answers[step.instanceId]?.value;
  session.numberDraft =
    (step.type === "quantity" || step.type === "custom_number") && (typeof prior === "number" || typeof prior === "string")
      ? String(prior)
      : "";

  if (step.type === "location_tree") {
    const node = await defaultLocationNode(db, step);
    if (node) session.locationCursor.currentParent = node._id.toString();
    return;
  }

  if (step.type === "category_tree") {
    await primeCategoryTree(db, session, step);
  }
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
async function advance(db: Db, session: BotSession): Promise<EngineResult> {
  session.stepIndex += 1;

  if (session.stepIndex >= session.steps.length) {
    session.locationCursor = { parentStack: [], currentParent: null };
    session.categoryCursor = emptyCategoryCursor();
    return finalize(db, session);
  }

  // Reset the location cursor whenever we enter/leave a step.
  await primeStep(db, session);

  const next = currentStep(session);
  if (next.type === "approval") {
    session.status = "awaiting_approval";
    session.approval = { stepInstanceId: next.instanceId, awaitingRole: String(next.config.approverRole || "Admin") };
  }
  if (next.type === "category_tree") {
    // No category matched the item and the author chose to step aside.
    if (String(next.config.whenUnmatched ?? "ask") === "skip" && next.config.matchItem !== false) {
      const all = await allActiveCategories(db);
      if (!matchCategory(all, itemNameForTree(session))) {
        session.answers[next.instanceId] = { type: "category_tree", value: "", display: "(skipped)" };
        return advance(db, session);
      }
    }
  }
  if (next.type === "nested_select") {
    // Nothing to ask about this item — record it as skipped and keep going, so a
    // workflow can carry a nested step for the items that have one without
    // stalling every entry that doesn't.
    if (await nestedNothingToAsk(db, session, next)) {
      session.answers[next.instanceId] = { type: "nested_select", value: "", display: "(skipped)" };
      return advance(db, session);
    }
    return enterNested(db, session, next);
  }
  return { render: await renderCurrentStep(db, session) };
}

async function goBack(db: Db, session: BotSession): Promise<EngineResult> {
  const step = currentStep(session);
  // Within the location tree, Back climbs one level before leaving the step.
  if (step?.type === "location_tree" && session.locationCursor.currentParent !== null) {
    session.locationCursor.currentParent = session.locationCursor.parentStack.pop() ?? null;
    return { render: await renderCurrentStep(db, session) };
  }
  // Within the category tree, Back climbs one level (Pipe ← PVC ← …) before
  // leaving the step. From the matched landing (e.g. Pipe), Back shows roots.
  if (step?.type === "category_tree" && categoryCursorOf(session).currentParent !== null) {
    const cursor = categoryCursorOf(session);
    cursor.currentParent = cursor.parentStack.pop() ?? null;
    return { render: await renderCurrentStep(db, session) };
  }
  // Within a nested step, Back undoes one level at a time before leaving it.
  if (step?.type === "nested_select" && session.nestedCursor) {
    const cursor = session.nestedCursor;
    const undone = cursor.path.pop();
    if (undone) {
      cursor.level = undone.level;
      // The position in the forest is wherever the deepest REMAINING node answer
      // left it, so undoing a list/text level doesn't move it at all.
      cursor.parentNodeId = [...cursor.path].reverse().find((p) => p.nodeId)?.nodeId ?? null;
      session.numberDraft = "";
      return { render: await renderCurrentStep(db, session) };
    }
    // At the top of a tree the user picked themselves: back to the picker.
    if (cursor.picked && cursor.treeId) {
      session.nestedCursor = emptyNestedCursor();
      return { render: await renderCurrentStep(db, session) };
    }
  }
  if (session.stepIndex === 0) return { notice: "You're at the first step." };

  // Walk back past nested steps that were skipped on the way in — they have
  // nothing to ask, so parking on one would strand the entry.
  let target = session.stepIndex - 1;
  while (target > 0 && (await nestedNothingToAsk(db, session, session.steps[target]))) target -= 1;
  if (await nestedNothingToAsk(db, session, session.steps[target])) return { notice: "You're at the first step." };

  session.stepIndex = target;
  // Stepping back INTO a location step lands on its default view too.
  await primeStep(db, session);
  session.status = "active";
  // Prior answers are intentionally preserved so nothing already entered is lost.
  const back = currentStep(session);
  if (back.type === "nested_select") return enterNested(db, session, back);
  return { render: await renderCurrentStep(db, session) };
}

// ---------------------------------------------------------------------------
// Finalizing an entry — i.e. generating the ticket
//
// This runs once per entry and must keep running once per entry no matter how
// the update that triggered it arrives. Three things can trigger it more than
// once for the same entry:
//
//   1. an impatient double tap on Confirm — two updates, two distinct update
//      ids, so the webhook's replay guard does not catch them;
//   2. Telegram redelivering an update we were too slow to acknowledge;
//   3. two instances handling those two updates concurrently.
//
// So the session is *claimed* with a conditional update before anything is
// written, and the entry itself carries the session id under a unique index.
// The claim serialises the common case; the index is the backstop for the case
// where both updates got past it. A losing caller re-reads the entry that won
// and shows the user that ticket, so a double tap looks like one confirmation
// rather than two tickets or an error.
// ---------------------------------------------------------------------------

// The key that ties one entry to one session. Sessions normally have an _id by
// the time an entry completes; a workflow short enough to finish on its very
// first update may not, and there the chat + originating update id is just as
// stable a key — and just as unique.
function entryKey(session: BotSession): string {
  if (session._id) return String(session._id);
  return `start:${session.chatId}:${session.startUpdateId ?? "0"}`;
}

// Claim the right to write this session's entry. Returns false when another
// update already finalized it.
async function claimSession(db: Db, session: BotSession): Promise<boolean> {
  if (!session._id) return true; // nothing persisted to race against yet
  const claimed = await db.collection("botSessions").findOneAndUpdate(
    { _id: session._id as ObjectId, status: { $ne: "completed" } },
    { $set: { status: "completed", updatedAt: new Date().toISOString() } }
  );
  return Boolean(claimed);
}

// Undo a claim whose entry never got written. Best effort: if this write fails
// too the session is simply left completed, which is the safe direction — an
// entry that can't be retried beats a duplicate one.
async function releaseClaim(db: Db, session: BotSession) {
  if (!session._id) return;
  session.status = "active";
  // The engine had already stepped past the last step to get here. Park the
  // cursor back on it so the user's next input re-runs the final step and can
  // complete the entry, instead of landing on a step that no longer exists.
  session.stepIndex = Math.min(session.stepIndex, Math.max(session.steps.length - 1, 0));
  // Written explicitly rather than left to the caller: the throw that follows
  // skips the webhook's own save.
  await db
    .collection("botSessions")
    .updateOne({ _id: session._id as ObjectId }, { $set: { status: "active", stepIndex: session.stepIndex } })
    .catch((err) => console.error("[engine] could not release the entry claim:", err));
}

async function alreadyTicketed(db: Db, session: BotSession): Promise<EngineResult> {
  session.status = "completed";
  const existing = await db
    .collection("inventoryEntries")
    .findOne({ sessionId: entryKey(session) }, { projection: { ticketNumber: 1 } });
  // The winner is still mid-insert (two instances, same instant). Acknowledge
  // without redrawing: its confirmation is the one that will land, and inventing
  // a second one here would either duplicate it or show a ticketless success.
  if (!existing?.ticketNumber) return { finished: true, notice: "This entry has already been submitted." };
  return {
    finished: true,
    render: { text: confirmationText(session, String(existing.ticketNumber)), keyboard: [] },
  };
}

function confirmationText(session: BotSession, ticketNumber: string): string {
  const header = ticketNumber
    ? `✅ <b>Inventory Successfully Added</b>\n🎫 Ticket: <code>${ticketNumber}</code>`
    : "✅ <b>Inventory Successfully Added</b>";
  return `${header}\n\n${summaryText(session)}`;
}

// Custom step labels are free text, and two steps in one workflow can carry the
// same one. Keying the map by label alone silently dropped the earlier answer;
// disambiguating keeps both, which is what the person filling the form expects.
function uniqueKey(existing: Record<string, string>, label: string): string {
  if (!(label in existing)) return label;
  for (let n = 2; ; n++) {
    const candidate = `${label} (${n})`;
    if (!(candidate in existing)) return candidate;
  }
}

async function finalize(db: Db, session: BotSession): Promise<EngineResult> {
  // Cheap in-memory guard for a re-entry inside one invocation; the claim below
  // is what covers separate requests and separate instances.
  if (session.status === "completed") return alreadyTicketed(db, session);
  if (!(await claimSession(db, session))) return alreadyTicketed(db, session);

  const custom: Record<string, string> = {};
  for (const s of session.steps) {
    const a = session.answers[s.instanceId];
    if (!a || a.display === "(skipped)") continue;
    if (s.type === "custom_text" || s.type === "custom_number") {
      custom[uniqueKey(custom, s.label || s.type)] = String(a.display);
    }
    // A nested step captured several named details, and each one is a field of
    // the entry in its own right: the ticket says "Colour: Red", not a single
    // opaque "Copper › Flexible › Red › 2.5 sq mm".
    if (s.type === "nested_select" || s.type === "category_tree") {
      for (const level of a.path ?? []) custom[uniqueKey(custom, level.label)] = level.value;
    }
  }

  const itemAnswer = answerFor(session, "item_capture");
  let product = answerFor(session, "product_select")?.product ?? itemAnswer?.product;

  // A product step supplies facts the entry would otherwise have to ask for
  // twice. An explicit answer always wins; the product only fills what the
  // workflow never asked, so a captured entry is complete either way.
  const itemName = String(itemAnswer?.value || product?.name || "");
  const categoryTree = answerFor(session, "category_tree");
  const categoryPath = categoryTree?.path ?? [];
  // Prefer the full Categories drill-down; fall back to the legacy two-step
  // category + subcategory picks (and then the product snapshot).
  const category = String(
    answerValue(session, "category_select") ??
      categoryPath[0]?.value ??
      product?.category ??
      ""
  );
  const subcategory = String(
    answerValue(session, "subcategory_select") ??
      categoryPath[1]?.value ??
      (categoryPath.length > 1 ? categoryPath[categoryPath.length - 1]?.value : "") ??
      product?.subcategory ??
      ""
  );
  const unit = String(
    answerValue(session, "unit_select") ??
      (typeof categoryTree?.tree === "string" ? categoryTree.tree : "") ??
      product?.unit ??
      ""
  );
  // One shape for a quantity: a number, or null when the workflow never asked.
  // It used to land as "" on a workflow without a quantity step and as a number
  // otherwise, so anything reading entries had to handle both.
  const rawQuantity = answerValue(session, "quantity");
  const parsedQuantity = rawQuantity === undefined || rawQuantity === "" ? NaN : Number(rawQuantity);
  const quantity = Number.isFinite(parsedQuantity) ? parsedQuantity : null;

  const now = new Date();
  const ticketNumber = await nextTicketNumber(db, now);

  // Default entry workflows capture a free-text item name (item_capture) rather
  // than a Product Master pick. Search and the stock ledger are product-keyed,
  // so resolve or create a product BEFORE writing the entry — otherwise the
  // ticket is durable but invisible to the Search group and never posts stock.
  if (!product && itemName) {
    const ensured = await ensureProductForEntry(db, {
      name: itemName,
      ticketNumber,
      category,
      subcategory,
      unit,
    });
    if (ensured) {
      product = {
        id: ensured.id,
        name: ensured.name,
        productNumber: ensured.productNumber,
        category: ensured.category || category,
        subcategory: ensured.subcategory || subcategory,
        unit: ensured.unit || unit,
        attributes: ensured.attributes,
      };
    }
  }

  // Did the worker explicitly pick category in this session? If so, keep it —
  // otherwise post-submit AI may fill / correct the product category.
  const userPickedCategory = Boolean(
    answerFor(session, "category_select") ||
      answerFor(session, "subcategory_select") ||
      (categoryTree && categoryTree.value)
  );

  const entry = {
    ticketNumber,
    // Unique-indexed: one session can only ever produce one ticket.
    sessionId: entryKey(session),
    workflowId: session.workflowId,
    version: session.version,
    chatId: session.chatId,
    submittedByUserId: session.userId,
    submittedByName: session.submittedByName,
    fields: {
      itemName,
      // Only set when there is one — an explicit `undefined` is stored as null
      // by the driver, which reads as "this entry had no image" versus "this
      // workflow never asked for one".
      ...(itemAnswer?.imageFileId ? { imageFileId: itemAnswer.imageFileId } : {}),
      ...(product
        ? {
            productId: product.id,
            productName: product.name,
            productNumber: product.productNumber,
            // Snapshotted at the moment of choice: a later edit to the Product
            // Master must not change what this ticket says was received.
            attributes: product.attributes,
          }
        : {}),
      category,
      subcategory,
      ...(categoryTree && categoryTree.value
        ? {
            categoryId: String(categoryTree.value),
            categoryPath: String(categoryTree.display ?? ""),
          }
        : {}),
      locationId: String(answerValue(session, "location_tree") ?? ""),
      locationPath: answerDisplay(session, "location_tree") ?? "",
      quantity,
      unit,
      custom,
    },
    ...(session.approval?.decision
      ? {
          approval: {
            status: session.approval.decision === "ok" ? "approved" : "rejected",
            by: session.approval.decidedBy ?? "",
          },
        }
      : {}),
    status: "Completed" as const,
    createdAt: now.toISOString(),
  };

  // The entry write stays awaited — "Inventory Successfully Added" must not be
  // sent before the row is durable. The audit row is bookkeeping, so it moves
  // behind the response instead of adding a second round trip to the wait.
  try {
    await db.collection("inventoryEntries").insertOne(entry);
  } catch (err) {
    // Both updates got past the claim (concurrent instances). The index held,
    // so exactly one entry exists — show its ticket instead of an error.
    if (isDuplicateKeyError(err)) return alreadyTicketed(db, session);
    // Anything else and the entry was NOT written. Hand the claim back, or the
    // session stays marked completed with no ticket behind it and the user can
    // neither retry nor recover what they typed.
    await releaseClaim(db, session);
    throw err;
  }
  session.status = "completed";

  // A completed entry is stock arriving, so it posts to the ledger the search /
  // request bot reads. The movement key is derived from the ticket number, so a
  // retry that got this far a second time writes the same row and the index
  // keeps one.
  //
  // Awaited so a frozen instance cannot drop it, but a failure is logged rather
  // than thrown: the entry row is already durable and the user is watching for
  // their ticket, so the recoverable outcome is a missing balance that
  // `scripts/backfill-stock.mjs` can replay — not a confirmation that never came.
  //
  // Needs product + location + quantity. Product is now resolved above for
  // item_capture workflows; without location or qty there is nowhere / nothing
  // to add, and the entry stays a record without pretending to be a balance.
  if (product && entry.fields.locationId && quantity !== null && quantity > 0) {
    await recordMovement(db, {
      movementKey: receiptKey(ticketNumber),
      productId: product.id,
      productName: product.name,
      productNumber: product.productNumber,
      locationId: entry.fields.locationId,
      locationPath: entry.fields.locationPath,
      qty: quantity,
      unit: unit || product.unit || "",
      reason: "receipt",
      refType: "inventoryEntry",
      refId: ticketNumber,
      by: session.submittedByName,
      createdAt: now.toISOString(),
    }).catch((err) => console.error("[engine] stock receipt failed:", err));
  } else if (!product) {
    console.error("[engine] entry stored without product — stock not posted", ticketNumber);
  } else if (!entry.fields.locationId || quantity === null || quantity <= 0) {
    console.warn(
      "[engine] entry stored without stock receipt (need location + qty)",
      ticketNumber,
      { locationId: entry.fields.locationId, quantity }
    );
  }

  // Background AI: reference names + category placement for Item Master / search.
  // Entry + stock stay awaited above so inventory data is durable first.
  //
  // Seed aliases (typed name + local spellings) are awaited BEFORE confirmation
  // so the Search / request group can find the item on the very next message —
  // without waiting for Nemotron. Full AI expansion stays deferred.
  if (product) {
    const productId = product.id;
    const productName = product.name;
    const seedNames = [itemName, productName].filter(Boolean);
    const localSeeds = [
      ...seedNames,
      ...seedNames.flatMap((s) => localReferenceExpansions(s)),
    ];
    await upsertAliases(db, productId, productName, localSeeds, "user").catch((err) =>
      console.error("[engine] seed aliases failed:", err)
    );
    // Belt-and-braces: product create already invalidates, but an existing
    // product / failed seed path must still refresh the search catalogue.
    invalidateCollection("products");

    const allowAiCategory =
      !userPickedCategory && !String(product.category || category || "").trim();
    defer(() =>
      enrichProductAfterSubmit(db, {
        productId,
        productName,
        productNumber: product.productNumber,
        ticketNumber,
        chatId: session.chatId,
        seedNames,
        allowAiCategory,
      })
    );
  }

  const productLine: [string, string][] = product
    ? [["Product", `${product.name} (${product.productNumber})`]]
    : [];
  defer(() =>
    logAudit(
      {
        action: "Created",
        dataType: "Inventory Entry",
        entity: ticketNumber,
        field: "New entry",
        before: "—",
        after: itemName || "(unnamed item)",
        beforeFields: [["Item", "—"]],
        afterFields: [
          ["Ticket", ticketNumber],
          ["Item", itemName || "—"],
          ...productLine,
          ["Category", category || "—"],
          ["Location", entry.fields.locationPath || "—"],
          ["Quantity", quantity === null ? "—" : `${quantity} ${unit}`.trim()],
        ],
      },
      session.submittedByName
    )
  );

  return { finished: true, render: { text: confirmationText(session, ticketNumber), keyboard: [] } };
}

/** After inventory is durable: fix name, expand reference names, assign category. */
async function enrichProductAfterSubmit(
  db: Db,
  opts: {
    productId: string;
    productName: string;
    productNumber: string;
    ticketNumber: string;
    chatId: string;
    seedNames: string[];
    allowAiCategory: boolean;
  }
): Promise<void> {
  let canonicalName = opts.productName;
  const seeds = [
    ...opts.seedNames,
    opts.productName,
    ...opts.seedNames.flatMap((s) => localReferenceExpansions(s)),
    ...localReferenceExpansions(opts.productName),
  ];

  if (!aiConfigured()) return;

  // Auto-created entry products get a cleaned Product Master name in the
  // background — never mid-conversation. Existing catalogue picks keep their names.
  const canRename = /^AUTO-/i.test(opts.productNumber || "");
  if (canRename) {
    const fixed = await fixProductName(opts.productName);
    if (fixed && fixed.trim().toLowerCase() !== opts.productName.trim().toLowerCase()) {
      const conflict = await findActiveProductByName(db, fixed);
      if (conflict && conflict._id.toString() !== opts.productId) {
        // Another product already owns the cleaned name — keep ours, tag the
        // suggestion as an alias so search still learns the spelling.
        await upsertAliases(db, opts.productId, opts.productName, [fixed, ...opts.seedNames], "ai");
        console.warn(
          `[ai] name fix "${opts.productName}" → "${fixed}" skipped (conflicts with ${conflict.productNumber})`
        );
      } else {
        const at = new Date().toISOString();
        const previous = opts.productName;
        await db.collection("products").updateOne(
          { _id: new ObjectId(opts.productId) },
          { $set: { name: fixed, updatedAt: at } }
        );
        await db.collection("inventoryEntries").updateOne(
          { ticketNumber: opts.ticketNumber },
          {
            $set: {
              "fields.itemName": fixed,
              "fields.productName": fixed,
            },
          }
        );
        await db.collection("stockMovements").updateMany(
          { refType: "inventoryEntry", refId: opts.ticketNumber, productId: opts.productId },
          { $set: { productName: fixed } }
        );
        // Old typing stays searchable; new name is canonical.
        await upsertAliases(db, opts.productId, fixed, [previous, ...opts.seedNames], "user");
        invalidateCollection("products");
        canonicalName = fixed;
        console.log(`[ai] fixed product name "${previous}" → "${fixed}"`);

        await sendMessage(
          opts.chatId,
          `✏️ <b>Item name was fixed</b>\n` +
            `<i>${escHtml(previous)}</i> → <b>${escHtml(fixed)}</b>\n` +
            `Ticket: <code>${escHtml(opts.ticketNumber)}</code>`
        ).catch((err) => console.error("[ai] name-fix notice failed:", err));
      }
    }
  }

  const expanded = await expandReferenceNames(canonicalName, seeds);
  await upsertAliases(db, opts.productId, canonicalName, expanded, "ai");
  console.log(`[ai] saved ${expanded.length} reference names for ${canonicalName}`);

  if (opts.allowAiCategory) {
    const cats = await allActiveCategories(db);
    const byId = await categoriesById(db);
    const paths = [
      ...new Set(
        cats
          .map((c) => categoryPathFrom(byId, c._id.toString()))
          .map((p) => p.trim())
          .filter(Boolean)
      ),
    ];
    const suggestion = await suggestCategoryForProduct(canonicalName, paths);
    if (suggestion?.category) {
      const at = new Date().toISOString();
      await db.collection("products").updateOne(
        { _id: new ObjectId(opts.productId) },
        {
          $set: {
            category: suggestion.category,
            subcategory: suggestion.subcategory || "",
            updatedAt: at,
          },
        }
      );
      await db.collection("inventoryEntries").updateOne(
        { ticketNumber: opts.ticketNumber },
        {
          $set: {
            "fields.category": suggestion.category,
            "fields.subcategory": suggestion.subcategory || "",
          },
        }
      );
      invalidateCollection("products");
      console.log(
        `[ai] category ${suggestion.category}${suggestion.subcategory ? ` › ${suggestion.subcategory}` : ""} for ${canonicalName}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Answer helpers
// ---------------------------------------------------------------------------
// The first step of a type that was actually ANSWERED. Matching on the step
// alone meant a workflow with two steps of one type (or a skipped optional one)
// reported the empty first answer and dropped the real one.
function answerFor(session: BotSession, type: string): Answer | undefined {
  for (const s of session.steps) {
    if (s.type !== type) continue;
    const a = session.answers[s.instanceId];
    if (a && a.display !== "(skipped)" && a.value !== "") return a;
  }
  return undefined;
}

function answerValue(session: BotSession, type: string): string | number | undefined {
  return answerFor(session, type)?.value;
}
function answerDisplay(session: BotSession, type: string): string | undefined {
  return answerFor(session, type)?.display;
}

function summaryText(session: BotSession): string {
  const lines: string[] = [];
  for (const s of session.steps) {
    const a = session.answers[s.instanceId];
    if (!a || a.display === "(skipped)") continue;
    if (s.type === "review_confirm" || s.type === "approval") continue;
    // A nested step asked several questions, so it reviews as several lines —
    // the user checks "Colour: Red" the same way they check every other answer.
    if (s.type === "nested_select" && a.path?.length) {
      for (const level of a.path) lines.push(`• <b>${escHtml(level.label)}:</b> ${escHtml(level.value)}`);
      continue;
    }
    if (s.type === "category_tree" && a.path?.length) {
      for (const level of a.path) lines.push(`• <b>${escHtml(level.label)}:</b> ${escHtml(level.value)}`);
      continue;
    }
    const label = s.label.replace(/[:：]\s*$/, "");
    lines.push(`• <b>${shortLabel(label, s.type)}:</b> ${a.display}`);
    // A product's attributes ARE the product for a user checking their entry —
    // 50 mm vs 80 mm is the whole difference — so they are spelled out under it
    // rather than left inside the stored snapshot.
    for (const attr of a.product?.attributes ?? []) {
      lines.push(`   ↳ ${attr.name}: ${attr.value}`);
    }
  }
  return lines.join("\n") || "<i>No data captured.</i>";
}

// Friendlier field names in the summary than the raw prompts.
function shortLabel(label: string, type: string): string {
  const defaults: Record<string, string> = {
    item_capture: "Item",
    product_select: "Product",
    category_select: "Category",
    subcategory_select: "Subcategory",
    category_tree: "Category",
    nested_select: "Details",
    location_tree: "Location",
    quantity: "Quantity",
    unit_select: "Unit",
  };
  return defaults[type] || label;
}
