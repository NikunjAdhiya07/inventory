// Shared shapes for the workflow builder + bot engine.

import type { ProductAttribute } from "./products";

export type StepType =
  | "item_capture"
  | "product_select"
  | "category_select"
  | "subcategory_select"
  | "category_tree"
  | "nested_select"
  | "location_tree"
  | "quantity"
  | "unit_select"
  | "custom_text"
  | "custom_number"
  | "approval"
  | "review_confirm";

export type StepConfig = {
  dataSource?: string;
  filterByCategory?: boolean;
  requireImage?: boolean;
  // location_tree: name of the node the step opens inside, so the common case is
  // reachable in one tap. The other top-level nodes stay one tap away too.
  defaultLocation?: string;
  // nested_select: the option tree to walk. Blank means "work it out from the
  // item the user already named", which is what lets ONE workflow ask wire
  // questions for wire and pipe questions for pipe.
  tree?: string;
  // category_tree / nested_select: open from the item name ("pipe" → Pipe).
  matchItem?: boolean;
  // What to do when no tree/category matches the item: step aside, or ask the
  // user to pick from the full list.
  whenUnmatched?: "skip" | "ask";
  placeholder?: string;
  approvalMode?: "single" | "multi";
  approverRole?: string;
  approverRoles?: string[];
  numberMin?: number;
  numberMax?: number;
  [key: string]: unknown;
};

export type StepInstance = {
  instanceId: string;
  type: StepType;
  label: string;
  required: boolean;
  order: number;
  config: StepConfig;
};

export type StepLibraryEntry = {
  id: string;
  type: StepType;
  name: string;
  desc: string;
  icon: string;
  category: string;
  configSchema: {
    key: string;
    label: string;
    type: "text" | "toggle" | "select" | "number" | "dataSource";
    default?: unknown;
    options?: string[];
    appliesToDataSource?: string;
    // What the empty option reads as when blank is a meaningful choice.
    blankLabel?: string;
  }[];
  order: number;
  status: string;
};

// What a product step captured, copied onto the answer at the moment of choice.
// It is a snapshot on purpose: editing a product in the console must not rewrite
// the tickets that were already raised against it.
export type ProductSnapshot = {
  id: string;
  name: string;
  productNumber: string;
  category: string;
  subcategory: string;
  unit: string;
  attributes: ProductAttribute[];
};

export type Answer = {
  type: StepType;
  value: string | number;
  display: string;
  imageFileId?: string;
  product?: ProductSnapshot;
  // nested_select: one entry per level answered, in the order they were asked.
  // The whole point of the step is the breakdown, so it is kept level by level
  // rather than only as the joined display — the ticket lists "Colour: Red" as
  // its own field, exactly as if the workflow had asked for it directly.
  tree?: string;
  path?: { label: string; value: string }[];
};

export type LocationCursor = {
  parentStack: string[]; // location ids from root down to current level's parent
  currentParent: string | null; // whose children are currently offered
};

// Same shape as LocationCursor: walks the Categories master until a leaf.
// `matchedId` is the node opened from the item name (e.g. Pipe) so the prompt
// can say so and Back can climb out of that landing cleanly.
export type CategoryCursor = {
  parentStack: string[];
  currentParent: string | null;
  matchedId?: string | null;
};

// Where a nested_select step has got to. Per-step scratch like `locationCursor`,
// reset by `primeStep` on every entry into a step.
export type NestedCursor = {
  treeId: string; // "" until a tree has been resolved or picked
  treeName: string;
  // Whether the user chose the tree from the picker. Only then does Back have a
  // picker to return to; a tree resolved from config or the item name has not.
  picked: boolean;
  level: number; // index into the tree's levels
  // The last node actually chosen FROM THE TREE — whose children the next node
  // level offers. List/text/number levels leave it alone, so a Size level under
  // a fixed-list Colour level still finds its options under the subcategory.
  parentNodeId: string | null;
  path: { level: number; label: string; value: string; nodeId?: string }[];
};

export type BotSession = {
  _id?: unknown;
  chatId: string;
  userId: string;
  dbUserId: string;
  submittedByName: string;
  workflowId: string;
  version: number;
  steps: StepInstance[]; // PINNED snapshot — the engine runs THIS, not the live head
  stepIndex: number;
  answers: Record<string, Answer>;
  locationCursor: LocationCursor;
  categoryCursor?: CategoryCursor;
  nestedCursor?: NestedCursor;
  // Digits typed so far on a number step's inline keypad. Per-step scratch, like
  // `locationCursor` — reset by `primeStep` on every entry into a step. The
  // committed value lands in `answers` only when the user taps Done.
  numberDraft: string;
  // Per-step scratch for a product step: what the user typed to narrow the list
  // and which page of results they are on. Reset by `primeStep`, like the two
  // above, so re-entering the step always starts from the full catalogue.
  productQuery?: string;
  productPage?: number;
  // AI / fuzzy suggestions on item_capture. While set with awaiting=true the
  // step shows pick buttons instead of advancing.
  itemSuggest?: {
    awaiting: boolean;
    typed?: string;
    labels: string[];
    imageFileId?: string;
    candidates: {
      name: string;
      productId?: string;
      productNumber?: string;
      score: number;
      source: string;
    }[];
  };
  approval?: { stepInstanceId: string; awaitingRole: string; decidedBy?: string; decision?: "ok" | "no" };
  status: "active" | "awaiting_approval" | "completed" | "cancelled";
  lastMessageId?: number;
  processedUpdateIds: number[];
  // The update that started this entry. It gives an entry a stable identity
  // before the session has ever been written, which is what keeps a workflow
  // short enough to finish on its first update from producing two tickets when
  // Telegram redelivers that update.
  startUpdateId?: number;
  createdAt: string;
  updatedAt: string;
};
