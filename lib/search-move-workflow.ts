// Fully configurable search-group movement conversation tree.
// Every node is equal — no fixed spine. The Workflows builder is source of truth;
// Telegram walks this tree node-by-node and ends at Add to Cart.

import type { Db } from "mongodb";
import { cached, invalidate } from "./cache";
import { newQuestionId, normalizeQuestions, type MoveQuestion, type MoveQuestionKind } from "./movement-questions";

export const SEARCH_MOVE_WORKFLOW_KEY = "search-move";

export type FlowNodeKind =
  | "search"
  | "pick_category"
  | "pick_location"
  | "pick_vendor"
  | "pick_department"
  | "select_movement"
  | "movement"
  | "location"
  | "from"
  | "to"
  | "qty"
  | "stock_in"
  | "stock_out"
  | "question"
  | "reference"
  | "remarks"
  | "review"
  | "add_to_cart"
  // Legacy kinds — normalized away on load/save
  | "pick_product"
  | "intent"
  | "record_hub"
  | "request_branch"
  | "done";

export type FlowNode = {
  id: string;
  kind: FlowNodeKind;
  label: string;
  /** Telegram prompt. Placeholders: {{product}} {{type}} {{unit}} {{qty}} {{where}} {{stock_lines}} {{children}} {{vendor}} {{department}} {{question}} */
  message: string;
  movementCode?: string;
  /** When set on select_movement, only these Movement Master codes are offered (tree order). */
  movementCodes?: string[];
  direction?: "in" | "out" | "transfer" | "adjust";
  question?: MoveQuestion;
  children: string[];
};

export type SearchMoveWorkflow = {
  key: typeof SEARCH_MOVE_WORKFLOW_KEY;
  name: string;
  rootId: string;
  nodes: Record<string, FlowNode>;
  updatedAt: string;
};

const COLLECTION = "searchMoveWorkflows";

const LEGACY_KINDS = new Set<FlowNodeKind>(["intent", "record_hub", "request_branch", "done"]);

function nid(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultMessage(kind: FlowNodeKind, label?: string): string {
  switch (kind) {
    case "search":
      return "Type an item name to search stock (e.g. pipe).";
    case "pick_category":
      return "“{{product}}” matches several categories.\n\nPick a category, then a subcategory:";
    case "pick_product":
      // Legacy — products come from search results, not a workflow node
      return "Pick an item:";
    case "pick_location":
    case "location":
      return "{{product}}\n\nPick a storage location:";
    case "pick_vendor":
      return "{{product}} — {{type}}\n\nPick the vendor:";
    case "pick_department":
      return "{{product}} — {{type}}\n\nWhich department is returning this item?";
    case "select_movement":
      return "{{product}}\n\nPick a movement:";
    case "movement":
      return "{{product}} — {{type}}";
    case "from":
      return "{{product}} — {{type}}\nWhere is it moving from?";
    case "to":
      return "{{product}} — {{type}}\nWhere is it moving to?";
    case "qty":
      return "{{product}} — {{type}}\n{{where}}\n\nQty: {{qty}} {{unit}}";
    case "stock_in":
      return "{{product}}\n\nConfirm: increase stock by {{qty}} {{unit}} at {{where}}?";
    case "stock_out":
      return "{{product}}\n\nConfirm: decrease stock by {{qty}} {{unit}} at {{where}}?";
    case "reference":
      return "Type the reference (document / ticket number).";
    case "remarks":
      return "Type the remarks.";
    case "review":
      return "Review, then add to cart.";
    case "add_to_cart":
    case "done":
      return "{{product}} × {{qty}} {{unit}}\n{{where}}\n{{type}}\n\nAdd this line to your cart?";
    case "question":
      return "{{type}}\n\n{{question}}";
    default:
      return label ? String(label) : "";
  }
}

function makeStep(kind: FlowNodeKind, label: string, message?: string): FlowNode {
  return {
    id: nid(kind),
    kind,
    label,
    message: message ?? defaultMessage(kind, label),
    children: [],
  };
}

function chain(kinds: { kind: FlowNodeKind; label: string; message?: string; question?: MoveQuestion; movementCodes?: string[] }[]): FlowNode[] {
  const nodes = kinds.map((k) => {
    const n = makeStep(k.kind, k.label, k.message);
    if (k.question) n.question = k.question;
    if (k.movementCodes) n.movementCodes = k.movementCodes;
    return n;
  });
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].children = [nodes[i + 1].id];
  return nodes;
}

/**
 * Default template: editable lead-in, then Select movement with side-by-side
 * movement roots (each branch is its own step tree ending in Add to cart).
 */
export function buildExampleWorkflow(): SearchMoveWorkflow {
  const lead = chain([
    { kind: "search", label: "Search item" },
    { kind: "pick_location", label: "Select location" },
    { kind: "select_movement", label: "Select movement" },
  ]);
  const hubs = lead[lead.length - 1];
  const nodes: Record<string, FlowNode> = {};
  for (const n of lead) nodes[n.id] = n;

  const examples: BranchExample[] = [
    {
      code: "return-from-plant",
      name: "Return from Plant",
      direction: "in",
      questions: [{ type: "select", label: "Which plant?", options: ["Plant A", "Plant B", "Plant C"] }],
    },
    {
      code: "issue-to-plant",
      name: "Issue to Plant",
      direction: "out",
      questions: [
        { type: "select", label: "Which plant?", options: ["Plant A", "Plant B", "Plant C"] },
        { type: "boolean", label: "Urgent issue?" },
      ],
    },
    {
      code: "warehouse-transfer",
      name: "Warehouse to Warehouse",
      direction: "transfer",
      questions: [{ type: "string", label: "Why are you transferring?" }],
    },
    {
      code: "vendor-replacement",
      name: "Vendor Replacement",
      direction: "out",
      includeVendor: true,
      includeReference: true,
      questions: [
        {
          type: "select",
          label: "Reason for Replacement",
          options: [
            "Damaged",
            "Defective",
            "Wrong Item",
            "Wrong Quantity",
            "Quality Rejection",
            "Expired",
            "Other",
          ],
        },
        {
          type: "string",
          label: "Additional reason / comment",
          required: false,
          placeholder: "Required if you selected Other",
        },
      ],
    },
    {
      code: "department-return",
      name: "Department Return",
      direction: "in",
      includeDepartment: true,
      includeReference: true,
      questions: [
        {
          type: "select",
          label: "Return Reason",
          options: [
            "Unused Material",
            "Excess Material",
            "Job Completed",
            "No Longer Required",
            "Wrong Material Issued",
            "Other",
          ],
        },
        {
          type: "string",
          label: "Additional reason / comment",
          required: false,
          placeholder: "Required if you selected Other",
        },
      ],
    },
    newPurchaseBranchExample(),
  ];

  for (const ex of examples) {
    attachMovementBranch(nodes, hubs, ex);
  }

  return {
    key: SEARCH_MOVE_WORKFLOW_KEY,
    name: "Search group · stock movements",
    rootId: lead[0].id,
    nodes,
    updatedAt: new Date().toISOString(),
  };
}

type BranchExample = {
  code: string;
  name: string;
  direction: "in" | "out" | "transfer";
  questions: { type: MoveQuestionKind; label: string; options?: string[]; required?: boolean; placeholder?: string }[];
  /** Questions asked after the reference step (e.g. Expected/Received on New Purchase). */
  questionsAfterReference?: {
    type: MoveQuestionKind;
    label: string;
    options?: string[];
    required?: boolean;
    placeholder?: string;
  }[];
  includeVendor?: boolean;
  /** When true, vendor is asked before location (New Purchase). Default: after location. */
  vendorBeforeLocation?: boolean;
  includeDepartment?: boolean;
  includeReference?: boolean;
  locationLabel?: string;
  locationMessage?: string;
  vendorLabel?: string;
  vendorMessage?: string;
  qtyMessage?: string;
  referenceLabel?: string;
  referenceMessage?: string;
};

function questionStep(
  q: { type: MoveQuestionKind; label: string; options?: string[]; required?: boolean; placeholder?: string }
): { kind: FlowNodeKind; label: string; question: MoveQuestion } {
  const question: MoveQuestion = {
    id: newQuestionId(),
    type: q.type,
    label: q.label,
    required: q.required !== false,
    order: 0,
    ...(q.options ? { options: q.options } : {}),
    ...(q.placeholder ? { placeholder: q.placeholder } : {}),
  };
  return { kind: "question", label: q.label, question };
}

function newPurchaseBranchExample(): BranchExample {
  return {
    code: "new-purchase",
    name: "New Purchase",
    direction: "in",
    includeVendor: true,
    vendorBeforeLocation: true,
    includeReference: true,
    vendorLabel: "Select vendor",
    vendorMessage: "{{product}} — {{type}}\n\nWhich vendor are you purchasing this item from?",
    locationLabel: "Receiving location",
    locationMessage: "{{product}} — {{type}}\n\nWhere will this item be received?",
    qtyMessage: "{{product}} — {{type}}\n{{where}}\n\nHow much are you purchasing?\n\nQty: {{qty}} {{unit}}",
    referenceLabel: "Purchase Reference",
    referenceMessage: "Type the PO number, invoice, or vendor reference.",
    questions: [
      {
        type: "number",
        label: "Unit Price",
        required: false,
        placeholder: "Unit cost (optional)",
      },
    ],
    questionsAfterReference: [
      {
        type: "select",
        label: "Expected / Received Status",
        options: ["Purchase Ordered / Expected", "Received"],
      },
    ],
  };
}

function attachMovementBranch(
  nodes: Record<string, FlowNode>,
  hub: FlowNode,
  ex: BranchExample
): void {
  const move: FlowNode = {
    id: nid("movement"),
    kind: "movement",
    label: ex.name,
    message: defaultMessage("movement"),
    movementCode: ex.code,
    direction: ex.direction,
    children: [],
  };
  nodes[move.id] = move;
  hub.children.push(move.id);

  const stepDefs: { kind: FlowNodeKind; label: string; message?: string; question?: MoveQuestion }[] = [];
  // Department Return starts with department (item already selected in lead-in).
  if (ex.includeDepartment) {
    stepDefs.push({
      kind: "pick_department",
      label: "Select department",
      message: defaultMessage("pick_department"),
    });
  }
  if (ex.includeVendor && ex.vendorBeforeLocation) {
    stepDefs.push({
      kind: "pick_vendor",
      label: ex.vendorLabel || "Select vendor",
      message: ex.vendorMessage || defaultMessage("pick_vendor"),
    });
  }
  if (ex.direction === "transfer") {
    stepDefs.push({ kind: "from", label: "From location" }, { kind: "to", label: "To location" });
  } else {
    const defaultInLabel = ex.code === "new-purchase" ? "Receiving location" : "Return location";
    const defaultInMsg =
      ex.code === "new-purchase"
        ? "{{product}} — {{type}}\n\nWhere will this item be received?"
        : "{{product}} — {{type}}\n\nWhere should the material be returned?";
    stepDefs.push({
      kind: "location",
      label: ex.locationLabel || (ex.direction === "out" ? "From location" : defaultInLabel),
      message:
        ex.locationMessage ||
        (ex.direction === "in" ? defaultInMsg : defaultMessage("location")),
    });
  }
  if (ex.includeVendor && !ex.vendorBeforeLocation) {
    stepDefs.push({
      kind: "pick_vendor",
      label: ex.vendorLabel || "Select vendor",
      message: ex.vendorMessage || defaultMessage("pick_vendor"),
    });
  }
  if (ex.qtyMessage) {
    stepDefs.push({ kind: "qty", label: "Quantity", message: ex.qtyMessage });
  } else if (ex.code === "department-return") {
    stepDefs.push({
      kind: "qty",
      label: "Quantity",
      message: "{{product}} — {{type}}\n{{where}}\n\nHow much are you returning?\n\nQty: {{qty}} {{unit}}",
    });
  } else {
    stepDefs.push({ kind: "qty", label: "Quantity", message: defaultMessage("qty") });
  }
  const effectKind = stockEffectKindForDirection(ex.direction);
  if (effectKind) {
    stepDefs.push({
      kind: effectKind,
      label: effectKind === "stock_in" ? "Increase stock (+)" : "Decrease stock (−)",
      message: defaultMessage(effectKind),
    });
  }
  for (const q of ex.questions) {
    stepDefs.push(questionStep(q));
  }
  if (ex.includeReference) {
    stepDefs.push({
      kind: "reference",
      label:
        ex.referenceLabel ||
        (ex.includeDepartment ? "Original Issue / Reference" : "Original Reference"),
      message:
        ex.referenceMessage ||
        (ex.includeDepartment
          ? "Type the original issue reference (e.g. ISS-000123)."
          : "Type the original PO, GRN, invoice, or receipt reference."),
    });
  }
  for (const q of ex.questionsAfterReference ?? []) {
    stepDefs.push(questionStep(q));
  }
  stepDefs.push({ kind: "review", label: "Review" }, { kind: "add_to_cart", label: "Add to cart" });

  const chained = chain(stepDefs);
  for (const n of chained) nodes[n.id] = n;
  if (chained[0]) move.children = [chained[0].id];
}

/** Idempotently add the Vendor Replacement branch to a saved workflow. */
export function ensureVendorReplacementBranch(workflow: SearchMoveWorkflow): SearchMoveWorkflow {
  if (movementBranches(workflow).some((n) => n.movementCode === "vendor-replacement")) {
    return workflow;
  }
  const hub = findSelectMovement(workflow);
  if (!hub) return workflow;
  const nodes = cloneNodes(workflow);
  const hubNode = nodes[hub.id];
  if (!hubNode) return workflow;
  attachMovementBranch(nodes, hubNode, {
    code: "vendor-replacement",
    name: "Vendor Replacement",
    direction: "out",
    includeVendor: true,
    includeReference: true,
    questions: [
      {
        type: "select",
        label: "Reason for Replacement",
        options: [
          "Damaged",
          "Defective",
          "Wrong Item",
          "Wrong Quantity",
          "Quality Rejection",
          "Expired",
          "Other",
        ],
      },
      {
        type: "string",
        label: "Additional reason / comment",
        required: false,
        placeholder: "Required if you selected Other",
      },
    ],
  });
  nodes[hub.id] = hubNode;
  return { ...workflow, nodes, updatedAt: new Date().toISOString() };
}

/** Idempotently add the Department Return branch to a saved workflow. */
export function ensureDepartmentReturnBranch(workflow: SearchMoveWorkflow): SearchMoveWorkflow {
  if (movementBranches(workflow).some((n) => n.movementCode === "department-return")) {
    return workflow;
  }
  const hub = findSelectMovement(workflow);
  if (!hub) return workflow;
  const nodes = cloneNodes(workflow);
  const hubNode = nodes[hub.id];
  if (!hubNode) return workflow;
  attachMovementBranch(nodes, hubNode, {
    code: "department-return",
    name: "Department Return",
    direction: "in",
    includeDepartment: true,
    includeReference: true,
    questions: [
      {
        type: "select",
        label: "Return Reason",
        options: [
          "Unused Material",
          "Excess Material",
          "Job Completed",
          "No Longer Required",
          "Wrong Material Issued",
          "Other",
        ],
      },
      {
        type: "string",
        label: "Additional reason / comment",
        required: false,
        placeholder: "Required if you selected Other",
      },
    ],
  });
  nodes[hub.id] = hubNode;
  return { ...workflow, nodes, updatedAt: new Date().toISOString() };
}

/** Idempotently add the New Purchase branch to a saved workflow. */
export function ensureNewPurchaseBranch(workflow: SearchMoveWorkflow): SearchMoveWorkflow {
  if (movementBranches(workflow).some((n) => n.movementCode === "new-purchase")) {
    return workflow;
  }
  const hub = findSelectMovement(workflow);
  if (!hub) return workflow;
  const nodes = cloneNodes(workflow);
  const hubNode = nodes[hub.id];
  if (!hubNode) return workflow;
  attachMovementBranch(nodes, hubNode, newPurchaseBranchExample());
  nodes[hub.id] = hubNode;
  return { ...workflow, nodes, updatedAt: new Date().toISOString() };
}

/** Ensure known Movement Master example branches exist on a saved tree. */
export function ensureConfiguredMovementBranches(workflow: SearchMoveWorkflow): SearchMoveWorkflow {
  let next = ensureVendorReplacementBranch(workflow);
  next = ensureDepartmentReturnBranch(next);
  next = ensureNewPurchaseBranch(next);
  next = ensureStockEffectStepsOnBranches(next);
  return next;
}

/** Direction → default Accept stock confirm step (transfers skip). */
export function stockEffectKindForDirection(
  direction: FlowNode["direction"] | undefined
): "stock_in" | "stock_out" | null {
  if (direction === "in") return "stock_in";
  if (direction === "out" || direction === "adjust") return "stock_out";
  return null;
}

/**
 * Idempotently insert Increase/Decrease stock after Quantity on every in/out
 * movement branch that does not already have a stock_in / stock_out step.
 */
export function ensureStockEffectStepsOnBranches(workflow: SearchMoveWorkflow): SearchMoveWorkflow {
  const moves = movementBranches(workflow);
  let nodes = cloneNodes(workflow);
  let changed = false;

  for (const move of moves) {
    const moveNode = nodes[move.id];
    if (!moveNode) continue;
    const steps = branchSteps({ ...workflow, nodes }, move.id);
    if (steps.some((id) => nodes[id]?.kind === "stock_in" || nodes[id]?.kind === "stock_out")) {
      continue;
    }
    const kind = stockEffectKindForDirection(moveNode.direction);
    if (!kind) continue;

    const effect = makeStepNode(kind);
    nodes[effect.id] = { ...effect, children: [] };

    let insertAt = steps.findIndex((id) => nodes[id]?.kind === "qty");
    if (insertAt >= 0) insertAt += 1;
    else {
      const beforeEnd = steps.findIndex(
        (id) => nodes[id]?.kind === "review" || nodes[id]?.kind === "add_to_cart"
      );
      insertAt = beforeEnd >= 0 ? beforeEnd : steps.length;
    }
    const nextSteps = [...steps];
    nextSteps.splice(insertAt, 0, effect.id);
    rewireBranch(nodes, move.id, nextSteps);
    changed = true;
  }

  if (!changed) return workflow;
  return { ...workflow, nodes, updatedAt: new Date().toISOString() };
}

/** True if the saved tree still uses the old fixed spine / request fork. */
export function needsLegacyMigration(workflow: SearchMoveWorkflow): boolean {
  return Object.values(workflow.nodes).some((n) => LEGACY_KINDS.has(n.kind));
}

/** Flat select_movement with no movement children — needs branch roots restored. */
export function needsBranchMigration(workflow: SearchMoveWorkflow): boolean {
  const hub = findSelectMovement(workflow);
  if (!hub) return true;
  return !hub.children.some((id) => workflow.nodes[id]?.kind === "movement");
}

export function normalizeWorkflow(raw: unknown): SearchMoveWorkflow {
  if (!raw || typeof raw !== "object") return buildExampleWorkflow();
  const r = raw as Record<string, unknown>;
  const nodesIn = r.nodes;
  if (!nodesIn || typeof nodesIn !== "object") return buildExampleWorkflow();
  const nodes: Record<string, FlowNode> = {};
  for (const [id, val] of Object.entries(nodesIn as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const v = val as Record<string, unknown>;
    let kind = String(v.kind ?? "") as FlowNodeKind;
    // Soft remap on normalize so old docs keep working until migrated.
    if (kind === "done") kind = "add_to_cart";
    if (kind === "record_hub") kind = "select_movement";
    // pick_product is not a workflow step — products come from search results.
    const children = Array.isArray(v.children) ? v.children.map(String) : [];
    const node: FlowNode = {
      id: String(v.id ?? id),
      kind,
      label: String(v.label ?? kind).slice(0, 80),
      message: String(v.message ?? defaultMessage(kind)),
      children,
    };
    if (v.movementCode) node.movementCode = String(v.movementCode);
    if (Array.isArray(v.movementCodes)) {
      node.movementCodes = v.movementCodes.map(String).filter(Boolean);
    }
    if (v.direction) node.direction = v.direction as FlowNode["direction"];
    if (v.question) {
      const qs = normalizeQuestions([v.question]);
      if (qs[0]) node.question = qs[0];
    }
    nodes[node.id] = node;
  }
  const rootId = String(r.rootId ?? "");
  if (!rootId || !nodes[rootId]) return buildExampleWorkflow();

  const workflow: SearchMoveWorkflow = {
    key: SEARCH_MOVE_WORKFLOW_KEY,
    name: String(r.name ?? "Search group · stock movements"),
    rootId,
    nodes,
    updatedAt: String(r.updatedAt ?? new Date().toISOString()),
  };

  if (needsLegacyMigration(workflow) || needsBranchMigration(workflow)) {
    return buildExampleWorkflow();
  }
  return workflow;
}

export async function getSearchMoveWorkflow(db: Db): Promise<SearchMoveWorkflow> {
  // Cache key bumped when stock_in/stock_out steps are ensured on all in/out branches.
  return cached("searchMoveWorkflow:v5", async () => {
    const doc = await db.collection(COLLECTION).findOne({ key: SEARCH_MOVE_WORKFLOW_KEY });
    if (!doc) {
      const example = buildExampleWorkflow();
      await db.collection(COLLECTION).updateOne(
        { key: SEARCH_MOVE_WORKFLOW_KEY },
        { $set: example },
        { upsert: true }
      );
      await syncQuestionsToMovementTypes(db, example);
      return example;
    }

    const rawNodes = doc.nodes && typeof doc.nodes === "object" ? (doc.nodes as Record<string, { kind?: string; children?: string[] }>) : {};
    const rawHadLegacy = Object.values(rawNodes).some((n) =>
      ["intent", "record_hub", "request_branch"].includes(String(n?.kind ?? ""))
    );
    const rawHub = Object.values(rawNodes).find((n) => n?.kind === "select_movement" || n?.kind === "record_hub");
    const rawHadNoBranches =
      !Object.values(rawNodes).some((n) => n?.kind === "movement") ||
      (rawHub && !(rawHub.children ?? []).some((cid) => rawNodes[cid]?.kind === "movement"));

    let workflow = normalizeWorkflow(doc);
    if (rawHadLegacy || rawHadNoBranches) {
      await db.collection(COLLECTION).updateOne(
        { key: SEARCH_MOVE_WORKFLOW_KEY },
        { $set: workflow },
        { upsert: true }
      );
      await syncQuestionsToMovementTypes(db, workflow);
    }
    const withConfigured = ensureConfiguredMovementBranches(workflow);
    if (withConfigured !== workflow) {
      workflow = withConfigured;
      await db.collection(COLLECTION).updateOne(
        { key: SEARCH_MOVE_WORKFLOW_KEY },
        { $set: workflow },
        { upsert: true }
      );
      await syncQuestionsToMovementTypes(db, workflow);
    }
    return workflow;
  });
}

export async function saveSearchMoveWorkflow(db: Db, workflow: SearchMoveWorkflow): Promise<SearchMoveWorkflow> {
  const next = ensureConfiguredMovementBranches(
    normalizeWorkflow({ ...workflow, updatedAt: new Date().toISOString() })
  );
  await db.collection(COLLECTION).updateOne({ key: SEARCH_MOVE_WORKFLOW_KEY }, { $set: next }, { upsert: true });
  await syncQuestionsToMovementTypes(db, next);
  invalidate("searchMoveWorkflow:v5");
  invalidate("searchMoveWorkflow:v4");
  invalidate("searchMoveWorkflow:v3");
  invalidate("searchMoveWorkflow:v2");
  invalidate("searchMoveWorkflow:main");
  invalidate("movementTypes:active");
  return next;
}

/** Sync each movement branch's question nodes onto that Movement Master type. */
export async function syncQuestionsToMovementTypes(db: Db, workflow: SearchMoveWorkflow): Promise<void> {
  for (const move of movementBranches(workflow)) {
    if (!move.movementCode) continue;
    const questions = collectQuestions(workflow, move.id);
    await db.collection("movementTypes").updateOne(
      { code: move.movementCode },
      { $set: { questions, updatedAt: new Date().toISOString() } }
    );
  }
}

export function collectQuestions(workflow: SearchMoveWorkflow, movementNodeId: string): MoveQuestion[] {
  const out: MoveQuestion[] = [];
  const visit = (id: string) => {
    const n = workflow.nodes[id];
    if (!n) return;
    if (n.kind === "question" && n.question) {
      out.push({ ...n.question, order: out.length, label: n.question.label || n.label });
    }
    for (const c of n.children) visit(c);
  };
  const move = workflow.nodes[movementNodeId];
  if (!move) return [];
  for (const c of move.children) visit(c);
  return normalizeQuestions(out);
}

export function movementCodesInTree(workflow: SearchMoveWorkflow): string[] {
  return movementBranches(workflow)
    .map((n) => n.movementCode)
    .filter((c): c is string => Boolean(c));
}

export function messageFor(workflow: SearchMoveWorkflow, kind: FlowNodeKind, movementCode?: string | null): string | null {
  if (movementCode) {
    const move = movementBranches(workflow).find((n) => n.movementCode === movementCode);
    if (move) {
      const found = findDescendantKind(workflow, move.id, kind);
      if (found?.message) return found.message;
    }
  }
  const shared = Object.values(workflow.nodes).find((n) => n.kind === kind);
  return shared?.message ?? null;
}

function findDescendantKind(workflow: SearchMoveWorkflow, startId: string, kind: FlowNodeKind): FlowNode | null {
  const n = workflow.nodes[startId];
  if (!n) return null;
  if (n.kind === kind) return n;
  for (const c of n.children) {
    const hit = findDescendantKind(workflow, c, kind);
    if (hit) return hit;
  }
  return null;
}

export function applyMessageTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

export function findParent(workflow: SearchMoveWorkflow, nodeId: string): FlowNode | null {
  for (const n of Object.values(workflow.nodes)) {
    if (n.children.includes(nodeId)) return n;
  }
  return null;
}

export function findSelectMovement(workflow: SearchMoveWorkflow): FlowNode | null {
  return Object.values(workflow.nodes).find((n) => n.kind === "select_movement") ?? null;
}

/** @deprecated alias */
export function findRecordHub(workflow: SearchMoveWorkflow): FlowNode | null {
  return findSelectMovement(workflow);
}

export function movementBranches(workflow: SearchMoveWorkflow): FlowNode[] {
  const hub = findSelectMovement(workflow);
  if (!hub) return Object.values(workflow.nodes).filter((n) => n.kind === "movement");
  return hub.children.map((id) => workflow.nodes[id]).filter((n): n is FlowNode => Boolean(n && n.kind === "movement"));
}

/**
 * Editable lead-in from root down to (and including) Select movement.
 * Does not descend into movement branches.
 */
export function leadInPath(workflow: SearchMoveWorkflow): string[] {
  const out: string[] = [];
  let id: string | undefined = workflow.rootId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const n: FlowNode | undefined = workflow.nodes[id];
    if (!n) break;
    out.push(id);
    if (n.kind === "select_movement") break;
    // Prefer non-movement child so we stay on the shared spine
    const next: string | undefined = n.children.find((c: string) => workflow.nodes[c]?.kind !== "movement") ?? n.children[0];
    id = next;
  }
  return out;
}

/** True when the lead-in includes a given kind (e.g. pick_category). */
export function leadInHasKind(workflow: SearchMoveWorkflow, kind: FlowNodeKind): boolean {
  return leadInPath(workflow).some((id) => workflow.nodes[id]?.kind === kind);
}

export function leadInNode(workflow: SearchMoveWorkflow, kind: FlowNodeKind): FlowNode | null {
  const id = leadInPath(workflow).find((i) => workflow.nodes[i]?.kind === kind);
  return id ? workflow.nodes[id] ?? null : null;
}

/**
 * First lead-in node after search / category discovery — where Telegram continues
 * once the user has picked an item (e.g. pick_location or select_movement).
 */
export function nodeAfterDiscovery(workflow: SearchMoveWorkflow): string | null {
  const skip = new Set<FlowNodeKind>(["search", "pick_category", "pick_product"]);
  for (const id of leadInPath(workflow)) {
    const n = workflow.nodes[id];
    if (n && !skip.has(n.kind)) return id;
  }
  return findSelectMovement(workflow)?.id ?? null;
}

function cloneNodes(workflow: SearchMoveWorkflow): Record<string, FlowNode> {
  const nodes: Record<string, FlowNode> = {};
  for (const [id, n] of Object.entries(workflow.nodes)) {
    nodes[id] = {
      ...n,
      children: [...n.children],
      ...(n.movementCodes ? { movementCodes: [...n.movementCodes] } : {}),
    };
  }
  return nodes;
}

/** Linear chain under a movement root (first-child path). */
export function branchSteps(workflow: SearchMoveWorkflow, movementId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    const n = workflow.nodes[id];
    if (n?.children[0]) walk(n.children[0]);
  };
  const move = workflow.nodes[movementId];
  if (!move) return out;
  for (const c of move.children) walk(c);
  return out;
}

/** @deprecated use branchSteps / leadInPath */
export function linearPath(workflow: SearchMoveWorkflow, startId?: string): string[] {
  if (!startId || startId === workflow.rootId) return leadInPath(workflow);
  const n = workflow.nodes[startId];
  if (n?.kind === "movement") return [startId, ...branchSteps(workflow, startId)];
  return branchSteps(workflow, startId);
}

export function linearSteps(workflow: SearchMoveWorkflow, movementId: string): string[] {
  return branchSteps(workflow, movementId);
}

function rewireBranch(nodes: Record<string, FlowNode>, movementId: string, stepIds: string[]): void {
  for (const id of stepIds) {
    if (nodes[id]) nodes[id] = { ...nodes[id], children: [] };
  }
  nodes[movementId] = { ...nodes[movementId], children: stepIds.length ? [stepIds[0]] : [] };
  for (let i = 0; i < stepIds.length - 1; i++) {
    nodes[stepIds[i]] = { ...nodes[stepIds[i]], children: [stepIds[i + 1]] };
  }
}

function rewireLeadIn(nodes: Record<string, FlowNode>, orderedIds: string[], hubChildren: string[]): string {
  for (const id of orderedIds) {
    if (!nodes[id]) continue;
    const isHub = nodes[id].kind === "select_movement";
    nodes[id] = { ...nodes[id], children: isHub ? [...hubChildren] : [] };
  }
  for (let i = 0; i < orderedIds.length - 1; i++) {
    const cur = nodes[orderedIds[i]];
    if (!cur || cur.kind === "select_movement") continue;
    nodes[orderedIds[i]] = { ...cur, children: [orderedIds[i + 1]] };
  }
  return orderedIds[0];
}

function isDescendant(workflow: SearchMoveWorkflow, ancestorId: string, maybeChildId: string): boolean {
  const n = workflow.nodes[ancestorId];
  if (!n) return false;
  for (const c of n.children) {
    if (c === maybeChildId) return true;
    if (isDescendant(workflow, c, maybeChildId)) return true;
  }
  return false;
}

export function enclosingMovement(workflow: SearchMoveWorkflow, nodeId: string): FlowNode | null {
  let cur: FlowNode | null = workflow.nodes[nodeId] ?? null;
  const seen = new Set<string>();
  while (cur) {
    if (cur.kind === "movement") return cur;
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = findParent(workflow, cur.id);
  }
  return null;
}

export function makeQuestionNode(kind: MoveQuestionKind): FlowNode {
  const label =
    kind === "boolean" ? "Yes or no?" : kind === "number" ? "Enter a number" : kind === "select" ? "Pick one" : "Enter text";
  const question: MoveQuestion = {
    id: newQuestionId(),
    type: kind,
    label,
    required: true,
    order: 0,
    ...(kind === "select" ? { options: ["Option A", "Option B"] } : {}),
  };
  return {
    id: nid("question"),
    kind: "question",
    label,
    message: defaultMessage("question"),
    question,
    children: [],
  };
}

export function makeStepNode(kind: FlowNodeKind): FlowNode {
  const labels: Partial<Record<FlowNodeKind, string>> = {
    search: "Search item",
    pick_category: "Pick category",
    pick_location: "Select location",
    pick_vendor: "Select vendor",
    pick_department: "Select department",
    select_movement: "Select movement",
    location: "Location",
    from: "From location",
    to: "To location",
    qty: "Quantity",
    stock_in: "Increase stock (+)",
    stock_out: "Decrease stock (−)",
    reference: "Reference",
    remarks: "Remarks",
    review: "Review",
    add_to_cart: "Add to cart",
    question: "Question",
  };
  return makeStep(kind, labels[kind] ?? kind);
}

/** Last stock_in / stock_out step in a movement branch wins (global Accept sign). */
export function resolveStockEffectFromBranch(
  workflow: SearchMoveWorkflow,
  movementNodeId: string
): "stock_in" | "stock_out" | undefined {
  let effect: "stock_in" | "stock_out" | undefined;
  for (const id of branchSteps(workflow, movementNodeId)) {
    const n = workflow.nodes[id];
    if (n?.kind === "stock_in") effect = "stock_in";
    if (n?.kind === "stock_out") effect = "stock_out";
  }
  return effect;
}

export function isSpine(_kind: FlowNodeKind): boolean {
  return false;
}

export function createMovementBranch(
  workflow: SearchMoveWorkflow,
  input: { code: string; name: string; direction: "in" | "out" | "transfer" | "adjust" }
): SearchMoveWorkflow {
  const hub = findSelectMovement(workflow);
  if (!hub) return workflow;
  if (movementBranches(workflow).some((n) => n.movementCode === input.code)) return workflow;

  const nodes = cloneNodes(workflow);
  const move: FlowNode = {
    id: nid("movement"),
    kind: "movement",
    label: input.name,
    message: defaultMessage("movement"),
    movementCode: input.code,
    direction: input.direction,
    children: [],
  };
  nodes[move.id] = move;

  const route: FlowNodeKind[] =
    input.direction === "transfer"
      ? ["from", "to", "qty", "review", "add_to_cart"]
      : input.direction === "in"
        ? ["location", "qty", "stock_in", "review", "add_to_cart"]
        : ["location", "qty", "stock_out", "review", "add_to_cart"];
  const steps = route.map((k) => {
    const labels: Record<string, string> = {
      location: input.direction === "out" ? "From location" : "To location",
      from: "From location",
      to: "To location",
      qty: "Quantity",
      stock_in: "Increase stock (+)",
      stock_out: "Decrease stock (−)",
      review: "Review",
      add_to_cart: "Add to cart",
    };
    return makeStep(k, labels[k] ?? k);
  });
  for (let i = 0; i < steps.length - 1; i++) steps[i].children = [steps[i + 1].id];
  for (const s of steps) nodes[s.id] = s;
  if (steps[0]) move.children = [steps[0].id];
  nodes[hub.id] = { ...nodes[hub.id], children: [...nodes[hub.id].children, move.id] };
  return { ...workflow, nodes };
}

export function insertNewAt(
  workflow: SearchMoveWorkflow,
  parentId: string,
  index: number,
  newNode: FlowNode
): SearchMoveWorkflow {
  const parent = workflow.nodes[parentId];
  if (!parent) return workflow;
  const nodes = cloneNodes(workflow);
  nodes[newNode.id] = { ...newNode, children: [] };

  // Movement roots under select_movement — sibling list
  if (parent.kind === "select_movement" || newNode.kind === "movement") {
    const hubId = parent.kind === "select_movement" ? parentId : findSelectMovement(workflow)?.id;
    if (!hubId) return workflow;
    const kids = [...nodes[hubId].children];
    const i = Math.max(0, Math.min(index, kids.length));
    kids.splice(i, 0, newNode.id);
    nodes[hubId] = { ...nodes[hubId], children: kids };
    return { ...workflow, nodes };
  }

  // Steps under a movement branch
  const move = parent.kind === "movement" ? parent : enclosingMovement(workflow, parentId);
  if (move) {
    const steps = branchSteps({ ...workflow, nodes }, move.id);
    const i = Math.max(0, Math.min(index, steps.length));
    steps.splice(i, 0, newNode.id);
    rewireBranch(nodes, move.id, steps);
    return { ...workflow, nodes };
  }

  // Lead-in path (before / around select_movement)
  const hub = findSelectMovement(workflow);
  const hubChildren = hub ? [...(nodes[hub.id]?.children ?? [])] : [];
  const path = leadInPath(workflow);
  const parentIdx = path.indexOf(parentId);
  if (parentIdx < 0) {
    nodes[parentId] = { ...nodes[parentId], children: [...nodes[parentId].children, newNode.id] };
    return { ...workflow, nodes };
  }
  const after = path.slice(parentIdx + 1);
  const i = Math.max(0, Math.min(index, after.length));
  const nextPath = [...path.slice(0, parentIdx + 1), ...after.slice(0, i), newNode.id, ...after.slice(i)];
  const newRoot = rewireLeadIn(nodes, nextPath, hubChildren);
  return { ...workflow, nodes, rootId: newRoot };
}

export function moveNodeTo(
  workflow: SearchMoveWorkflow,
  nodeId: string,
  targetParentId: string,
  index: number
): SearchMoveWorkflow {
  const node = workflow.nodes[nodeId];
  const target = workflow.nodes[targetParentId];
  if (!node || !target) return workflow;
  if (nodeId === targetParentId || nodeId === workflow.rootId) return workflow;
  if (isDescendant(workflow, nodeId, targetParentId)) return workflow;

  if (node.kind === "movement") {
    const hub = findSelectMovement(workflow);
    if (!hub || target.kind !== "select_movement") return workflow;
    const nodes = cloneNodes(workflow);
    const kids = nodes[hub.id].children.filter((c) => c !== nodeId);
    const i = Math.max(0, Math.min(index, kids.length));
    kids.splice(i, 0, nodeId);
    nodes[hub.id] = { ...nodes[hub.id], children: kids };
    return { ...workflow, nodes };
  }

  const fromMove = enclosingMovement(workflow, nodeId);
  const toMove = target.kind === "movement" ? target : enclosingMovement(workflow, targetParentId);
  if (fromMove && toMove) {
    const nodes = cloneNodes(workflow);
    const oldSteps = branchSteps(workflow, fromMove.id).filter((id) => id !== nodeId);
    rewireBranch(nodes, fromMove.id, oldSteps);
    nodes[nodeId] = { ...nodes[nodeId], children: [] };
    const steps = branchSteps({ ...workflow, nodes }, toMove.id);
    const i = Math.max(0, Math.min(index, steps.length));
    steps.splice(i, 0, nodeId);
    rewireBranch(nodes, toMove.id, steps);
    return { ...workflow, nodes };
  }

  // Lead-in reorder
  const hub = findSelectMovement(workflow);
  const hubChildren = hub ? [...hub.children] : [];
  const path = leadInPath(workflow).filter((id) => id !== nodeId);
  const parentIdx = path.indexOf(targetParentId);
  if (parentIdx < 0) return workflow;
  const after = path.slice(parentIdx + 1);
  const i = Math.max(0, Math.min(index, after.length));
  const nextPath = [...path.slice(0, parentIdx + 1), ...after.slice(0, i), nodeId, ...after.slice(i)];
  const nodes = cloneNodes(workflow);
  const newRoot = rewireLeadIn(nodes, nextPath, hubChildren);
  return { ...workflow, nodes, rootId: newRoot };
}

export function dropAt(
  workflow: SearchMoveWorkflow,
  target: { parentId: string; index: number },
  payload:
    | { source: "tree-node"; nodeId: string }
    | { source: "palette-movement"; code: string; name: string; direction: string }
    | { source: "palette-question"; kind: MoveQuestionKind }
    | { source: "palette-step"; kind: FlowNodeKind }
): SearchMoveWorkflow {
  const parent = workflow.nodes[target.parentId];
  if (!parent) return workflow;

  if (payload.source === "tree-node") {
    return moveNodeTo(workflow, payload.nodeId, target.parentId, target.index);
  }

  if (payload.source === "palette-movement") {
    const hub = parent.kind === "select_movement" ? parent : findSelectMovement(workflow);
    if (!hub) return workflow;
    const dir = (["in", "out", "transfer", "adjust"].includes(payload.direction)
      ? payload.direction
      : "in") as "in" | "out" | "transfer" | "adjust";
    const next = createMovementBranch(workflow, { code: payload.code, name: payload.name, direction: dir });
    const created = movementBranches(next).find((n) => n.movementCode === payload.code);
    const nextHub = findSelectMovement(next);
    if (!created || !nextHub) return next;
    return moveNodeTo(next, created.id, nextHub.id, target.index);
  }

  if (payload.source === "palette-question") {
    const move = parent.kind === "movement" ? parent : enclosingMovement(workflow, parent.id);
    if (!move) return workflow;
    return insertNewAt(workflow, move.id, target.index, makeQuestionNode(payload.kind));
  }

  if (payload.source === "palette-step") {
    if (payload.kind === "movement" || payload.kind === "question") return workflow;
    // Lead-in steps (search, location, …) or branch steps
    if (parent.kind === "select_movement") {
      // Insert on lead-in before hub by targeting hub's parent
      const hubParent = findParent(workflow, parent.id);
      if (!hubParent) return insertNewAt(workflow, workflow.rootId, 0, makeStepNode(payload.kind));
      const lead = leadInPath(workflow);
      const hubIdx = lead.indexOf(parent.id);
      return insertNewAt(workflow, hubParent.id, Math.max(0, hubIdx - lead.indexOf(hubParent.id) - 1), makeStepNode(payload.kind));
    }
    const move = parent.kind === "movement" ? parent : enclosingMovement(workflow, parent.id);
    if (move) return insertNewAt(workflow, move.id, target.index, makeStepNode(payload.kind));
    return insertNewAt(workflow, target.parentId, target.index, makeStepNode(payload.kind));
  }

  return workflow;
}

export function removeNode(workflow: SearchMoveWorkflow, nodeId: string): SearchMoveWorkflow {
  const node = workflow.nodes[nodeId];
  if (!node) return workflow;

  if (node.kind === "movement") {
    const nodes = cloneNodes(workflow);
    const drop = new Set<string>();
    const walk = (id: string) => {
      drop.add(id);
      for (const c of nodes[id]?.children ?? []) walk(c);
    };
    walk(nodeId);
    for (const [id, n] of Object.entries(nodes)) {
      if (n.children.includes(nodeId)) {
        nodes[id] = { ...n, children: n.children.filter((c) => c !== nodeId) };
      }
    }
    for (const id of drop) delete nodes[id];
    return { ...workflow, nodes };
  }

  const move = enclosingMovement(workflow, nodeId);
  if (move) {
    const nodes = cloneNodes(workflow);
    const steps = branchSteps(workflow, move.id).filter((id) => id !== nodeId);
    rewireBranch(nodes, move.id, steps);
    delete nodes[nodeId];
    return { ...workflow, nodes };
  }

  if (node.kind === "select_movement") return workflow; // keep hub — delete movements instead

  if (nodeId === workflow.rootId) {
    const child = node.children.find((c) => workflow.nodes[c]?.kind !== "movement");
    if (!child) return workflow;
    const hub = findSelectMovement(workflow);
    const hubChildren = hub ? [...hub.children] : [];
    const path = leadInPath(workflow).filter((id) => id !== nodeId);
    const nodes = cloneNodes(workflow);
    delete nodes[nodeId];
    const newRoot = rewireLeadIn(nodes, path, hubChildren);
    return { ...workflow, nodes, rootId: newRoot };
  }

  const hub = findSelectMovement(workflow);
  const hubChildren = hub ? [...hub.children] : [];
  const path = leadInPath(workflow).filter((id) => id !== nodeId);
  const nodes = cloneNodes(workflow);
  delete nodes[nodeId];
  const newRoot = rewireLeadIn(nodes, path, hubChildren);
  return { ...workflow, nodes, rootId: newRoot };
}

export function updateNode(workflow: SearchMoveWorkflow, nodeId: string, patch: Partial<FlowNode>): SearchMoveWorkflow {
  const node = workflow.nodes[nodeId];
  if (!node) return workflow;
  const next: FlowNode = { ...node, ...patch, id: node.id, kind: patch.kind ?? node.kind };
  if (patch.question && node.question) {
    next.question = { ...node.question, ...patch.question };
    if (patch.question.label) next.label = patch.question.label;
  }
  if (typeof patch.message === "string") next.message = patch.message;
  if (typeof patch.label === "string") next.label = patch.label;
  if (patch.movementCodes) next.movementCodes = [...patch.movementCodes];
  return { ...workflow, nodes: { ...workflow.nodes, [nodeId]: next } };
}

export function nextNodeId(workflow: SearchMoveWorkflow, nodeId: string): string | null {
  const n = workflow.nodes[nodeId];
  if (!n) return null;
  // From select_movement, next is chosen via movement pick — not automatic first child
  if (n.kind === "select_movement") return null;
  return n.children[0] ?? null;
}

/** After picking a movement type, enter that branch's first step. */
export function enterMovementBranch(workflow: SearchMoveWorkflow, movementCode: string): string | null {
  const move = movementBranches(workflow).find((n) => n.movementCode === movementCode);
  if (!move) return null;
  return move.children[0] ?? move.id;
}

export function prevNodeId(workflow: SearchMoveWorkflow, nodeId: string): string | null {
  const node = workflow.nodes[nodeId];
  if (!node) return null;
  const parent = findParent(workflow, nodeId);
  if (!parent) return null;
  // From first step of a branch, back goes to select_movement
  if (parent.kind === "movement") {
    const steps = branchSteps(workflow, parent.id);
    if (steps[0] === nodeId) return findSelectMovement(workflow)?.id ?? parent.id;
  }
  if (parent.kind === "select_movement" && node.kind === "movement") {
    return parent.id;
  }
  return parent.id;
}

// ---------------------------------------------------------------------------
// Interactive preview (Try it like Telegram)
// ---------------------------------------------------------------------------

export type PreviewButton = {
  label: string;
  action:
    | "next"
    | "back"
    | "restart"
    | "pick_category"
    | "pick_product"
    | "pick_move"
    | "pick_loc"
    | "pick_vendor"
    | "pick_department"
    | "qty_digit"
    | "qty_del"
    | "qty_ok"
    | "answer"
    | "confirm"
    | "skip"
    | "add_cart";
  value?: string;
};

export type PreviewScreen = {
  id: string;
  title: string;
  text: string;
  buttons: PreviewButton[];
  input?: { placeholder: string; kind: "search" | "text" | "number" };
};

export type PreviewSimState = {
  nodeId: string | null;
  movementCode: string | null;
  qtyDraft: string;
  answers: Record<string, string>;
  product: string;
  /** Trail through the sample category tree, e.g. ["MS Pipe", "Round", "Schedule 40"]. */
  categoryPath: string[];
  /** @deprecated tip of categoryPath — kept for older preview callers */
  category: string;
  location: string;
  vendor: string;
  department: string;
  done: boolean;
};

const SAMPLE_UNIT = "Meter";
const SAMPLE_STOCK = "📍 Main warehouse — 120\n📍 Plant shelf — 40\n📍 Store room — 25";
const SAMPLE_WHERE = "Main warehouse";
const SAMPLE_CATEGORIES = ["MS Pipe", "PVC Pipe", "GI Pipe", "UPVC Pipe"];
/** Nested sample tree — mirrors Categories master children at every depth. */
const SAMPLE_CHILDREN: Record<string, string[]> = {
  "MS Pipe": ["Round", "Square"],
  Round: ["Light", "Medium", "Heavy"],
  Square: ["40mm", "50mm"],
  "PVC Pipe": ["Pressure", "Conduit"],
  Pressure: ["Class B", "Class C"],
  Conduit: ["20mm", "25mm"],
  "GI Pipe": ["Light", "Medium", "Heavy"],
  "UPVC Pipe": ["Class B", "Class C"],
};
const SAMPLE_LOCS = ["Main warehouse", "Plant shelf", "Store room"];
const SAMPLE_VENDORS = ["ABC Vendor", "Precision Pipes Ltd", "Metro Plumbing Supply", "SafeFit Industrial"];
const SAMPLE_DEPARTMENTS = ["Production", "Maintenance", "Electrical", "Quality", "Stores", "Packaging"];
const SAMPLE_MOVES: Record<string, string> = {
  "return-from-plant": "Return from Plant",
  "issue-to-plant": "Issue to Plant",
  "warehouse-transfer": "Warehouse to Warehouse",
  "vendor-replacement": "Vendor Replacement",
  "department-return": "Department Return",
  "new-purchase": "New Purchase",
};

export function initialPreviewState(_movementCode?: string | null): PreviewSimState {
  return {
    nodeId: null,
    movementCode: null,
    qtyDraft: "",
    answers: {},
    product: "pipe",
    categoryPath: [],
    category: "",
    location: "",
    vendor: "",
    department: "",
    done: false,
  };
}

function previewPath(state: PreviewSimState): string[] {
  if (state.categoryPath?.length) return state.categoryPath;
  return state.category ? [state.category] : [];
}

function sampleChildrenOf(path: string[]): string[] {
  const tip = path[path.length - 1];
  if (!tip) return [];
  return SAMPLE_CHILDREN[tip] ?? [];
}

function screenVars(state: PreviewSimState, typeLabel = ""): Record<string, string> {
  const path = previewPath(state);
  const tip = path[path.length - 1] || "";
  const children = tip ? (SAMPLE_CHILDREN[tip] ?? []).join(", ") : "";
  return {
    product: state.product || "pipe",
    type: typeLabel,
    unit: SAMPLE_UNIT,
    qty: state.qtyDraft || "—",
    where: state.location || SAMPLE_WHERE,
    stock_lines: state.location ? `📍 ${state.location} — stock available` : SAMPLE_STOCK,
    children,
    vendor: state.vendor || "ABC Vendor",
    department: state.department || "Production",
    question: "",
  };
}

function textFor(node: FlowNode, vars: Record<string, string>): string {
  return applyMessageTemplate(node.message || defaultMessage(node.kind, node.label), vars)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function typeLabel(state: PreviewSimState): string {
  if (!state.movementCode) return "";
  return SAMPLE_MOVES[state.movementCode] ?? state.movementCode;
}

/** Skip silent stock_in / stock_out markers (and bare movement roots) in the Try-it preview. */
function skipSilentPreviewNodes(
  workflow: SearchMoveWorkflow,
  state: PreviewSimState
): PreviewSimState {
  let nodeId = state.nodeId ?? workflow.rootId;
  for (let i = 0; i < 20; i++) {
    const n = workflow.nodes[nodeId];
    if (!n) break;
    if (n.kind === "stock_in" || n.kind === "stock_out" || n.kind === "movement") {
      const next = n.children[0];
      if (!next) break;
      nodeId = next;
      continue;
    }
    break;
  }
  return nodeId === state.nodeId ? state : { ...state, nodeId };
}

function skipSilentPreviewBack(
  workflow: SearchMoveWorkflow,
  nodeId: string
): string {
  let id = nodeId;
  for (let i = 0; i < 20; i++) {
    const n = workflow.nodes[id];
    if (!n || (n.kind !== "stock_in" && n.kind !== "stock_out")) break;
    const prev = prevNodeId(workflow, id);
    if (!prev) break;
    id = prev;
  }
  return id;
}

export function previewScreen(workflow: SearchMoveWorkflow, state: PreviewSimState): PreviewScreen {
  state = skipSilentPreviewNodes(workflow, state);
  const nodeId = state.nodeId ?? workflow.rootId;
  const node = workflow.nodes[nodeId];

  if (state.done || !node) {
    return {
      id: "cart",
      title: "In cart",
      text: `Added to cart.\n\n${state.product} × ${state.qtyDraft || "12"} ${SAMPLE_UNIT}\n${state.location || SAMPLE_WHERE}\n${typeLabel(state)}`,
      buttons: [{ label: "Search again", action: "restart" }],
    };
  }

  const vars = {
    ...screenVars(state, typeLabel(state)),
    question: node.kind === "question" ? node.label : "",
  };
  let text = textFor(node, vars);
  if (node.kind === "qty") text = textFor(node, { ...vars, qty: `<b>${state.qtyDraft || "—"}</b>` });

  const buttons: PreviewButton[] = [];

  if (node.kind === "search") {
    return {
      id: node.id,
      title: node.label,
      text,
      buttons: [{ label: `Search “pipe”`, action: "next", value: "pipe" }],
      input: { placeholder: "Type an item name…", kind: "search" },
    };
  }

  if (node.kind === "pick_category") {
    const path = previewPath(state);
    if (!path.length) {
      buttons.push(...SAMPLE_CATEGORIES.map((c) => ({ label: c, action: "pick_category" as const, value: c })));
    } else {
      const uniqueSubs = sampleChildrenOf(path);
      const scope = path.join(" › ");
      const prompt = applyMessageTemplate(node.message || defaultMessage("pick_category"), {
        ...vars,
        product: state.product || "pipe",
        children: uniqueSubs.join(", "),
      });
      const usePrompt = node.message.includes("{{children}}");
      text = `${usePrompt ? prompt : state.product || "pipe"}\n\n<b>${scope}</b>\n<b>${
        uniqueSubs.length
      } option${uniqueSubs.length === 1 ? "" : "s"}</b>\n\nPick next:`;
      buttons.push(...uniqueSubs.map((s) => ({ label: s, action: "pick_category" as const, value: `sub:${s}` })));
    }
  } else if (node.kind === "pick_location" || node.kind === "location" || node.kind === "from" || node.kind === "to") {
    buttons.push(...SAMPLE_LOCS.map((l) => ({ label: `📍 ${l}`, action: "pick_loc" as const, value: l })));
  } else if (node.kind === "pick_vendor") {
    buttons.push(...SAMPLE_VENDORS.map((v) => ({ label: v, action: "pick_vendor" as const, value: v })));
  } else if (node.kind === "pick_department") {
    buttons.push(
      ...SAMPLE_DEPARTMENTS.map((d) => ({ label: d, action: "pick_department" as const, value: d }))
    );
  } else if (node.kind === "select_movement") {
    const moves = movementBranches(workflow);
    if (moves.length) {
      buttons.push(
        ...moves.map((m) => ({
          label: m.label,
          action: "pick_move" as const,
          value: m.movementCode,
        }))
      );
    } else {
      const codes = node.movementCodes?.length ? node.movementCodes : Object.keys(SAMPLE_MOVES);
      buttons.push(
        ...codes.map((c) => ({
          label: SAMPLE_MOVES[c] ?? c,
          action: "pick_move" as const,
          value: c,
        }))
      );
    }
  } else if (node.kind === "qty") {
    for (const d of ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"]) {
      buttons.push({ label: d, action: "qty_digit", value: d });
    }
    buttons.push({ label: "⌫", action: "qty_del" }, { label: "✔ Next", action: "qty_ok" });
  } else if (node.kind === "question" && node.question?.type === "boolean") {
    buttons.push({ label: "Yes", action: "answer", value: "Yes" }, { label: "No", action: "answer", value: "No" });
  } else if (node.kind === "question" && node.question?.type === "select") {
    for (const opt of (node.question.options ?? []).slice(0, 8)) {
      buttons.push({ label: opt, action: "answer", value: opt });
    }
  } else if (node.kind === "question" && node.question?.type === "number") {
    for (const d of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]) {
      buttons.push({ label: d, action: "qty_digit", value: d });
    }
    buttons.push({ label: "⌫", action: "qty_del" }, { label: "✔ Next", action: "qty_ok" });
  } else if (node.kind === "question" && node.question?.type === "string") {
    if (!node.question.required) buttons.push({ label: "Skip ⤵", action: "skip" });
  } else if (node.kind === "review") {
    const answerLines = Object.entries(state.answers)
      .map(([k, v]) => `· ${k}: ${v}`)
      .join("\n");
    const dept = state.department ? `\nDepartment: ${state.department}` : "";
    const vendor = state.vendor && state.movementCode === "vendor-replacement" ? `\nVendor: ${state.vendor}` : "";
    text = `${text}\n\n${state.product} × ${state.qtyDraft || "12"} ${SAMPLE_UNIT}\n${state.location || SAMPLE_WHERE}${dept}${vendor}${
      answerLines ? `\n${answerLines}` : ""
    }`;
    buttons.push({ label: "✔ Continue", action: "confirm" });
  } else if (node.kind === "add_to_cart") {
    const dept = state.department ? `\nDepartment: ${state.department}` : "";
    text = `${text}\n\n${state.product} × ${state.qtyDraft || "12"} ${SAMPLE_UNIT}\n${state.location || SAMPLE_WHERE}${dept}\n${typeLabel(state)}`;
    buttons.push({ label: "✔ Add to cart", action: "add_cart" });
  } else if (node.kind === "reference" || node.kind === "remarks") {
    // typed in real bot; preview advances
    buttons.push({ label: "✔ Next", action: "next" });
  } else {
    buttons.push({ label: "✔ Next", action: "next" });
  }

  buttons.push({ label: "⬅ Back", action: "back" });
  return { id: node.id, title: node.label, text, buttons };
}

function advance(workflow: SearchMoveWorkflow, state: PreviewSimState): PreviewSimState {
  const id = state.nodeId ?? workflow.rootId;
  const next = nextNodeId(workflow, id);
  if (!next) return { ...state, done: true };
  return skipSilentPreviewNodes(workflow, { ...state, nodeId: next });
}

export function applyPreviewAction(
  workflow: SearchMoveWorkflow,
  state: PreviewSimState,
  action: PreviewButton["action"],
  value?: string
): PreviewSimState {
  if (action === "restart") {
    return { ...initialPreviewState(), nodeId: workflow.rootId };
  }

  const nodeId = state.nodeId ?? workflow.rootId;
  const node = workflow.nodes[nodeId];

  if (action === "back") {
    const path = previewPath(state);
    if (path.length && workflow.nodes[nodeId]?.kind === "pick_category") {
      const nextPath = path.slice(0, -1);
      return {
        ...state,
        categoryPath: nextPath,
        category: nextPath[0] || "",
        done: false,
      };
    }
    const prev = prevNodeId(workflow, nodeId);
    if (!prev) return { ...state, nodeId: workflow.rootId, done: false };
    return { ...state, nodeId: skipSilentPreviewBack(workflow, prev), done: false };
  }

  if (action === "pick_category") {
    const path = previewPath(state);
    if (value?.startsWith("sub:")) {
      const name = value.slice(4);
      const nextPath = [...path, name];
      const deeper = sampleChildrenOf(nextPath);
      const nextState = {
        ...state,
        categoryPath: nextPath,
        category: nextPath[0] || "",
        product: state.product || "pipe",
      };
      // Keep drilling while the tip has children; only then advance the flowchart.
      if (deeper.length) return nextState;
      return advance(workflow, nextState);
    }
    const nextPath = [value || path[0] || ""].filter(Boolean);
    return {
      ...state,
      categoryPath: nextPath,
      category: nextPath[0] || "",
      product: "pipe",
    };
  }
  if (action === "pick_product") {
    // Legacy — ignore; items come from search results
    return advance(workflow, { ...state, product: value || state.product });
  }
  if (action === "pick_loc") {
    return advance(workflow, { ...state, location: value || state.location });
  }
  if (action === "pick_vendor") {
    return advance(workflow, { ...state, vendor: value || state.vendor });
  }
  if (action === "pick_department") {
    return advance(workflow, { ...state, department: value || state.department });
  }
  if (action === "pick_move") {
    const code = value || state.movementCode || "";
    const entered = enterMovementBranch(workflow, code);
    return {
      ...state,
      movementCode: code,
      nodeId: entered ?? state.nodeId,
      qtyDraft: "",
      answers: {},
    };
  }
  if (action === "qty_digit") {
    return { ...state, qtyDraft: (state.qtyDraft + (value ?? "")).slice(0, 12) };
  }
  if (action === "qty_del") return { ...state, qtyDraft: state.qtyDraft.slice(0, -1) };
  if (action === "qty_ok") {
    if (node?.kind === "question" && node.question?.type === "number") {
      return advance(workflow, {
        ...state,
        answers: { ...state.answers, [node.label]: state.qtyDraft || "0" },
      });
    }
    const qty = state.qtyDraft || "12";
    return advance(workflow, { ...state, qtyDraft: qty });
  }
  if (action === "answer" || action === "skip") {
    const label = node?.label ?? "Answer";
    const answers = action === "skip" ? state.answers : { ...state.answers, [label]: value ?? "" };
    return advance(workflow, { ...state, answers });
  }
  if (action === "confirm" || action === "next") {
    if (node?.kind === "search") {
      return advance(workflow, { ...state, product: value?.trim() || "pipe", nodeId: workflow.rootId });
    }
    return advance(workflow, state);
  }
  if (action === "add_cart") {
    return { ...state, done: true, qtyDraft: state.qtyDraft || "12" };
  }
  return state;
}

/** Slideshow helper for any leftover callers. */
export function previewFrames(
  workflow: SearchMoveWorkflow,
  _movementCode: string,
  _sample: { product: string; unit: string; stockLines: string; where: string }
): { id: string; title: string; text: string; buttons: string[] }[] {
  let state: PreviewSimState = { ...initialPreviewState(), nodeId: workflow.rootId };
  const out: { id: string; title: string; text: string; buttons: string[] }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const screen = previewScreen(workflow, state);
    const key = `${state.nodeId}:${state.done}:${screen.id}`;
    if (seen.has(key)) break;
    seen.add(key);
    out.push({ id: screen.id, title: screen.title, text: screen.text, buttons: screen.buttons.map((b) => b.label) });
    if (state.done) break;
    const btn = screen.buttons.find(
      (b) =>
        b.action === "pick_loc" ||
        b.action === "pick_vendor" ||
        b.action === "pick_department" ||
        b.action === "pick_move" ||
        b.action === "qty_ok" ||
        b.action === "confirm" ||
        b.action === "answer" ||
        b.action === "next" ||
        b.action === "add_cart"
    );
    if (!btn) break;
    if (btn.action === "qty_ok" && !state.qtyDraft) state = { ...state, qtyDraft: "12" };
    if (btn.action === "answer") state = applyPreviewAction(workflow, state, "answer", btn.value || "Yes");
    else state = applyPreviewAction(workflow, state, btn.action, btn.value);
  }
  return out;
}
