import type { Db, Document, ObjectId } from "mongodb";
import { logAudit } from "./audit";
import { cached } from "./cache";
import { defer } from "./defer";
import {
  activeLocations,
  locationChildren,
  locationParentIds,
  locationPathById,
} from "./locations";
import { isDuplicateKeyError } from "./mongodb";
import { activeProducts } from "./product-store";
import { attributeValues, productLabel, productMatches, type ProductAttribute } from "./products";
import { receiptKey, recordMovement } from "./stock";
import { buttonRows, type InlineKeyboard } from "./telegram";
import { nextTicketNumber } from "./ticket";
import type { Answer, BotSession, ProductSnapshot, StepInstance } from "./workflow-types";

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
  return cached("categories:active", () =>
    db.collection("categories").find({ status: "Active" }).sort({ order: 1, name: 1 }).toArray()
  );
}

async function activeSubcategories(db: Db, parentName?: string) {
  const all = await cached("subcategories:active", () =>
    db.collection("subcategories").find({ status: "Active" }).sort({ order: 1, name: 1 }).toArray()
  );
  return parentName ? all.filter((s) => s.parent === parentName) : all;
}

async function activeUnits(db: Db) {
  return cached("units:active", () =>
    db.collection("units").find({ status: "Active" }).sort({ name: 1 }).toArray()
  );
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
  const category = step.config.filterByCategory ? answerValue(session, "category_select") : undefined;
  const scoped = category ? all.filter((p) => String(p.category ?? "") === String(category)) : all;
  const query = session.productQuery ?? "";
  return query ? scoped.filter((p) => productMatches(p, query)) : scoped;
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
// Navigation helpers
// ---------------------------------------------------------------------------
function currentStep(session: BotSession): StepInstance {
  return session.steps[session.stepIndex];
}

function canGoBack(session: BotSession): boolean {
  const step = currentStep(session);
  if (step?.type === "location_tree" && session.locationCursor.currentParent !== null) return true;
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
function numberPadText(step: StepInstance, draft: string): string {
  const label = step.label || step.type;
  const min = Number(step.config.numberMin) || 0;
  const max = Number(step.config.numberMax) || 0;
  const hint = min && max ? `Allowed: ${min}–${max}` : min ? `Minimum: ${min}` : max ? `Maximum: ${max}` : "";
  // The draft is echoed so the user can see what they've keyed before committing.
  return `${label}\n\n<b>${draft || "—"}</b>${hint ? `\n<i>${hint}</i>` : ""}`;
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

// Validate and record a number answer. The keypad's Done key is the only caller
// today, but bounds checking lives here rather than inline so there is exactly
// one definition of what counts as a valid answer for a number step.
async function commitNumber(db: Db, session: BotSession, step: StepInstance, raw: string): Promise<EngineResult> {
  const text = raw.trim();
  if (!text) return { notice: "Enter a number first." };
  const n = Number(text);
  if (!Number.isFinite(n)) return { notice: "That isn't a valid number." };
  const min = Number(step.config.numberMin) || 0;
  const max = Number(step.config.numberMax) || 0;
  if (min && n < min) return { notice: `Must be at least ${min}.` };
  if (max && n > max) return { notice: `Must be at most ${max}.` };
  session.answers[step.instanceId] = { type: step.type, value: n, display: String(n) };
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
export async function renderCurrentStep(db: Db, session: BotSession): Promise<RenderResult> {
  const step = currentStep(session);
  if (!step) return { text: "…", keyboard: [] };
  const label = step.label || step.type;

  switch (step.type) {
    case "item_capture":
      return { text: label, keyboard: navRow(session) };

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
      const name = (input.text ?? "").trim();
      const image = input.imageFileId;
      if (step.config.requireImage && !image && !session.answers[step.instanceId]?.imageFileId) {
        return { notice: "Please send a photo of the item." };
      }
      if (!name && !image && !session.answers[step.instanceId]) {
        return { notice: "Send the item name and/or a photo." };
      }
      session.answers[step.instanceId] = {
        type: "item_capture",
        value: name || session.answers[step.instanceId]?.value || "",
        display: name || String(session.answers[step.instanceId]?.value || "(image)"),
        imageFileId: image || session.answers[step.instanceId]?.imageFileId,
      };
      return advance(db, session);
    }

    case "custom_text": {
      const t = (input.text ?? "").trim();
      if (!t) return { notice: "Please send some text." };
      session.answers[step.instanceId] = { type: "custom_text", value: t, display: t };
      return advance(db, session);
    }

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
    return advance(db, session);
  }

  switch (step.type) {
    case "quantity":
    case "custom_number": {
      if (!data.startsWith("num:")) return { notice: "Use the keypad above." };
      const pressed = data.slice(4);
      let draft = session.numberDraft ?? "";

      if (pressed === "ok") return commitNumber(db, session, step, draft);

      if (pressed === "del") {
        draft = draft.slice(0, -1);
      } else if (pressed === ".") {
        if (draft.includes(".")) return { notice: "Only one decimal point." };
        draft = draft === "" ? "0." : `${draft}.`;
      } else {
        // A 15-digit quantity is a mis-tap, not an entry, and the draft has to
        // stay well inside Telegram's message limits.
        if (draft.replace(".", "").length >= 12) return { notice: "That's as long as a number can get." };
        // Keeps a leading tap of 0 from turning 5 into "05".
        draft = draft === "0" ? pressed : draft + pressed;
      }

      session.numberDraft = draft;
      return { render: await renderCurrentStep(db, session) };
    }

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
  const step = currentStep(session);
  if (!step) return;

  // Stepping back INTO a number step reopens the keypad on the value already
  // entered, so Back preserves it the same way it preserves every other answer.
  const prior = session.answers[step.instanceId]?.value;
  session.numberDraft =
    (step.type === "quantity" || step.type === "custom_number") && (typeof prior === "number" || typeof prior === "string")
      ? String(prior)
      : "";

  if (step.type !== "location_tree") return;
  const node = await defaultLocationNode(db, step);
  if (node) session.locationCursor.currentParent = node._id.toString();
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
async function advance(db: Db, session: BotSession): Promise<EngineResult> {
  session.stepIndex += 1;

  if (session.stepIndex >= session.steps.length) {
    session.locationCursor = { parentStack: [], currentParent: null };
    return finalize(db, session);
  }

  // Reset the location cursor whenever we enter/leave a step.
  await primeStep(db, session);

  const next = currentStep(session);
  if (next.type === "approval") {
    session.status = "awaiting_approval";
    session.approval = { stepInstanceId: next.instanceId, awaitingRole: String(next.config.approverRole || "Admin") };
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
  if (session.stepIndex === 0) return { notice: "You're at the first step." };

  session.stepIndex -= 1;
  // Stepping back INTO a location step lands on its default view too.
  await primeStep(db, session);
  session.status = "active";
  // Prior answers are intentionally preserved so nothing already entered is lost.
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
  }

  const itemAnswer = answerFor(session, "item_capture");
  const product = answerFor(session, "product_select")?.product;

  // A product step supplies facts the entry would otherwise have to ask for
  // twice. An explicit answer always wins; the product only fills what the
  // workflow never asked, so a captured entry is complete either way.
  const itemName = String(itemAnswer?.value || product?.name || "");
  const category = String(answerValue(session, "category_select") ?? product?.category ?? "");
  const subcategory = String(answerValue(session, "subcategory_select") ?? product?.subcategory ?? "");
  const unit = String(answerValue(session, "unit_select") ?? product?.unit ?? "");
  // One shape for a quantity: a number, or null when the workflow never asked.
  // It used to land as "" on a workflow without a quantity step and as a number
  // otherwise, so anything reading entries had to handle both.
  const rawQuantity = answerValue(session, "quantity");
  const parsedQuantity = rawQuantity === undefined || rawQuantity === "" ? NaN : Number(rawQuantity);
  const quantity = Number.isFinite(parsedQuantity) ? parsedQuantity : null;

  const now = new Date();
  const ticketNumber = await nextTicketNumber(db, now);

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

  // A completed entry is stock arriving, so it posts to the ledger the request
  // bot reads. The movement key is derived from the ticket number, so a retry
  // that got this far a second time writes the same row and the index keeps one.
  //
  // Awaited so a frozen instance cannot drop it, but a failure is logged rather
  // than thrown: the entry row is already durable and the user is watching for
  // their ticket, so the recoverable outcome is a missing balance that
  // `scripts/backfill-stock.mjs` can replay — not a confirmation that never came.
  //
  // A workflow with no product step, no location or no quantity cannot post —
  // there is nothing to add, nowhere to add it, or no amount to add. Those
  // entries stay a record of what happened without pretending to be a balance.
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
    location_tree: "Location",
    quantity: "Quantity",
    unit_select: "Unit",
  };
  return defaults[type] || label;
}
