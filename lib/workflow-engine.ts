import type { Db } from "mongodb";
import { logAudit } from "./audit";
import { cached } from "./cache";
import { defer } from "./defer";
import { buttonRows, type InlineKeyboard } from "./telegram";
import type { BotSession, StepInstance } from "./workflow-types";

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

// The whole active location tree in one query. It backs both child listings and
// id lookups, so walking a path costs no round trips at all — it used to cost one
// per level.
async function activeLocations(db: Db) {
  return cached("locations:active", () =>
    db.collection("locations").find({ status: "Active" }).sort({ name: 1 }).toArray()
  );
}

async function locationChildren(db: Db, parent: string | null) {
  const all = await activeLocations(db);
  // Mongo's `{ parent: null }` matches a missing field too, so normalise here.
  return all.filter((l) => (l.parent ?? null) === parent);
}

async function locationsById(db: Db) {
  const all = await activeLocations(db);
  return new Map(all.map((l) => [l._id.toString(), l]));
}

// Ids that have at least one active child. Drives both the button icon and the
// decision to select-on-tap, without a query per option.
async function locationParentIds(db: Db): Promise<Set<string>> {
  const all = await activeLocations(db);
  const ids = new Set<string>();
  for (const l of all) if (l.parent) ids.add(String(l.parent));
  return ids;
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

// Full path of a node, walked up through its parents. Independent of how the
// cursor arrived there, so it stays correct after a jump between branches.
async function locationPathById(db: Db, id: string): Promise<string> {
  const byId = await locationsById(db);
  const names: string[] = [];
  let node = byId.get(id);
  // Guard against a cycle in the stored parent pointers.
  for (let hops = 0; node && hops < 20; hops++) {
    names.unshift(String(node.name));
    node = node.parent ? byId.get(String(node.parent)) : undefined;
  }
  return names.join(" › ");
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

// Standard footer: [Back?] [Skip?] [Cancel]
function navRow(session: BotSession): InlineKeyboard {
  const step = currentStep(session);
  const row = [];
  if (canGoBack(session)) row.push({ text: "⬅ Back", callback_data: "cb:back" });
  if (step && !step.required && step.type !== "review_confirm") row.push({ text: "Skip ⤼", callback_data: "cb:skip" });
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
      return { text: `${label}\n<i>Send a number.</i>`, keyboard: navRow(session) };

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

    case "quantity":
    case "custom_number": {
      const n = Number((input.text ?? "").trim());
      if (!Number.isFinite(n)) return { notice: "Please send a valid number." };
      const min = Number(step.config.numberMin) || 0;
      const max = Number(step.config.numberMax) || 0;
      if (min && n < min) return { notice: `Must be at least ${min}.` };
      if (max && n > max) return { notice: `Must be at most ${max}.` };
      session.answers[step.instanceId] = { type: step.type, value: n, display: String(n) };
      return advance(db, session);
    }

    case "custom_text": {
      const t = (input.text ?? "").trim();
      if (!t) return { notice: "Please send some text." };
      session.answers[step.instanceId] = { type: "custom_text", value: t, display: t };
      return advance(db, session);
    }

    default:
      // Button-only step. A typed message can't answer it, so re-render the step
      // rather than emit a nudge: the webhook redraws the anchor message in place,
      // which leaves the existing prompt and its buttons exactly as they are.
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
    session.answers[step.instanceId] = { type: step.type, value: "", display: "(skipped)" };
    return advance(db, session);
  }

  switch (step.type) {
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

// Position the location cursor for a step that is about to be shown. A step
// configured with a default node opens inside it, so the common case costs one
// tap instead of two; everything else starts at the root as before.
//
// Exported so a session whose FIRST step is a location step is primed too — the
// engine's own entry points (advance/goBack) cover every later step.
export async function primeLocationCursor(db: Db, session: BotSession) {
  session.locationCursor = { parentStack: [], currentParent: null };
  const step = currentStep(session);
  if (step?.type !== "location_tree") return;
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
  await primeLocationCursor(db, session);

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
  await primeLocationCursor(db, session);
  session.status = "active";
  // Prior answers are intentionally preserved so nothing already entered is lost.
  return { render: await renderCurrentStep(db, session) };
}

async function finalize(db: Db, session: BotSession): Promise<EngineResult> {
  const custom: Record<string, string> = {};
  for (const s of session.steps) {
    const a = session.answers[s.instanceId];
    if (!a) continue;
    if (s.type === "custom_text" || s.type === "custom_number") custom[s.label] = String(a.display);
  }

  const itemStep = session.steps.find((s) => s.type === "item_capture");
  const itemAnswer = itemStep ? session.answers[itemStep.instanceId] : undefined;

  const entry = {
    workflowId: session.workflowId,
    version: session.version,
    chatId: session.chatId,
    submittedByUserId: session.userId,
    submittedByName: session.submittedByName,
    fields: {
      itemName: itemAnswer ? String(itemAnswer.value) : "",
      imageFileId: itemAnswer?.imageFileId,
      category: answerValue(session, "category_select") ?? "",
      subcategory: answerValue(session, "subcategory_select") ?? "",
      locationId: answerValue(session, "location_tree") ?? "",
      locationPath: answerDisplay(session, "location_tree") ?? "",
      quantity: answerValue(session, "quantity") ?? "",
      unit: answerValue(session, "unit_select") ?? "",
      custom,
    },
    approval: session.approval?.decision ? { status: session.approval.decision === "ok" ? "approved" : "rejected", by: session.approval.decidedBy } : undefined,
    status: "Completed" as const,
    createdAt: new Date().toISOString(),
  };

  // The entry write stays awaited — "Inventory Successfully Added" must not be
  // sent before the row is durable. The audit row is bookkeeping, so it moves
  // behind the response instead of adding a second round trip to the wait.
  await db.collection("inventoryEntries").insertOne(entry);
  session.status = "completed";
  defer(() =>
    logAudit(
      {
        action: "Created",
        dataType: "Inventory Entry",
        entity: entry.fields.itemName || "(unnamed item)",
        field: "New entry",
        before: "—",
        after: entry.fields.itemName || "(unnamed item)",
        beforeFields: [["Item", "—"]],
        afterFields: [
          ["Item", entry.fields.itemName || "—"],
          ["Category", String(entry.fields.category)],
          ["Location", String(entry.fields.locationPath)],
          ["Quantity", `${entry.fields.quantity} ${entry.fields.unit}`],
        ],
      },
      session.submittedByName
    )
  );

  return {
    finished: true,
    render: { text: `✅ <b>Inventory Successfully Added</b>\n\n${summaryText(session)}`, keyboard: [] },
  };
}

// ---------------------------------------------------------------------------
// Answer helpers
// ---------------------------------------------------------------------------
function answerValue(session: BotSession, type: string): string | number | undefined {
  const step = session.steps.find((s) => s.type === type);
  return step ? session.answers[step.instanceId]?.value : undefined;
}
function answerDisplay(session: BotSession, type: string): string | undefined {
  const step = session.steps.find((s) => s.type === type);
  return step ? session.answers[step.instanceId]?.display : undefined;
}

function summaryText(session: BotSession): string {
  const lines: string[] = [];
  for (const s of session.steps) {
    const a = session.answers[s.instanceId];
    if (!a || a.display === "(skipped)") continue;
    if (s.type === "review_confirm" || s.type === "approval") continue;
    const label = s.label.replace(/[:：]\s*$/, "");
    lines.push(`• <b>${shortLabel(label, s.type)}:</b> ${a.display}`);
  }
  return lines.join("\n") || "<i>No data captured.</i>";
}

// Friendlier field names in the summary than the raw prompts.
function shortLabel(label: string, type: string): string {
  const defaults: Record<string, string> = {
    item_capture: "Item",
    category_select: "Category",
    subcategory_select: "Subcategory",
    location_tree: "Location",
    quantity: "Quantity",
    unit_select: "Unit",
  };
  return defaults[type] || label;
}
