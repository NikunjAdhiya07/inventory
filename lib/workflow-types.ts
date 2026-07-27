// Shared shapes for the workflow builder + bot engine.

export type StepType =
  | "item_capture"
  | "category_select"
  | "subcategory_select"
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
  }[];
  order: number;
  status: string;
};

export type Answer = {
  type: StepType;
  value: string | number;
  display: string;
  imageFileId?: string;
};

export type LocationCursor = {
  parentStack: string[]; // location ids from root down to current level's parent
  currentParent: string | null; // whose children are currently offered
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
  // Digits typed so far on a number step's inline keypad. Per-step scratch, like
  // `locationCursor` — reset by `primeStep` on every entry into a step. The
  // committed value lands in `answers` only when the user taps Done.
  numberDraft: string;
  approval?: { stepInstanceId: string; awaitingRole: string; decidedBy?: string; decision?: "ok" | "no" };
  status: "active" | "awaiting_approval" | "completed" | "cancelled";
  lastMessageId?: number;
  processedUpdateIds: number[];
  createdAt: string;
  updatedAt: string;
};
