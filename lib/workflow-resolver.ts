import { ObjectId, type Db, type Document } from "mongodb";
import { cached } from "./cache";
import type { StepInstance } from "./workflow-types";

export type ResolvedWorkflow = {
  workflowId: string;
  version: number;
  steps: StepInstance[];
};

// Resolve which workflow applies for an entry starting in a given Telegram
// group. Precedence (Active assignments/workflows only):
//   1. group assignment matching this chatId  (ties: priority desc, createdAt asc)
//   2. the default workflow (isDefault: true)
//   3. none -> null (bot replies "no workflow configured")
//
// Category-scoped assignments are intentionally not resolved here: the category
// is only known mid-conversation, but the step set is pinned at entry start.
// They act as an entry-point selector for category-first flows (future work),
// not a mid-run switch. The pinned snapshot is always the workflow's CURRENT
// active version, captured into the session so later edits don't disturb it.
// Cached per chat: this is three sequential round trips (assignments → workflow →
// version snapshot) and it ran on every single new entry, even though the answer
// only changes when an admin reassigns or re-activates a workflow. Both of those
// writes invalidate the cache, and the TTL bounds staleness regardless.
export async function resolveWorkflow(db: Db, chatId: string): Promise<ResolvedWorkflow | null> {
  return cached(`resolved-workflow:${chatId}`, () => resolveWorkflowUncached(db, chatId));
}

async function resolveWorkflowUncached(db: Db, chatId: string): Promise<ResolvedWorkflow | null> {
  const groupAssignments = await db
    .collection("workflowAssignments")
    .find({ scope: "group", chatId, status: "Active" })
    .sort({ priority: -1, createdAt: 1 })
    .toArray();

  const assignedIds = groupAssignments
    .map((a) => toObjectId(a.workflowId))
    .filter((id): id is ObjectId => id instanceof ObjectId);

  // One query for every candidate instead of one per candidate in a loop, then
  // pick the first that survives in assignment order.
  if (assignedIds.length) {
    const active = await db
      .collection("workflows")
      .find({ _id: { $in: assignedIds }, status: "Active" })
      .toArray();
    const byId = new Map(active.map((w) => [w._id.toString(), w]));
    for (const id of assignedIds) {
      const wf = byId.get(id.toString());
      if (wf) return pin(db, wf);
    }
  }

  const fallback = await db.collection("workflows").findOne({ isDefault: true, status: "Active" });
  if (fallback) return pin(db, fallback);

  return null;
}

function toObjectId(id: string): ObjectId | string {
  try {
    return new ObjectId(id);
  } catch {
    return id;
  }
}

// Pin the workflow's current active version snapshot into a resolved result.
// Falls back to the live head steps if no snapshot exists (shouldn't happen for
// an Active workflow, but keeps the bot resilient).
async function pin(db: Db, wf: Document): Promise<ResolvedWorkflow> {
  const workflowId = wf._id.toString();
  const version = wf.version || 0;
  const snapshot = await db.collection("workflowVersions").findOne({ workflowId, version });
  const steps = (snapshot?.steps ?? wf.steps ?? []) as StepInstance[];
  return { workflowId, version, steps: [...steps].sort((a, b) => a.order - b.order) };
}
