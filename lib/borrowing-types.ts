// Borrow identifiers, kept free of every runtime import.
//
// `search-move-workflow.ts` is bundled into the Workflows builder, which is a
// client component — anything it imports has to be reachable in the browser.
// The borrowing logic itself reads and writes Mongo, so the two names the
// flowchart needs live here instead of being dragged in with the driver.

export const BORROW_MOVEMENT_CODE = "borrow";

/** Movement Master display name. The flowchart branch adds the icon. */
export const BORROW_MOVEMENT_NAME = "Borrow";

export const BORROW_BRANCH_LABEL = "🔧 Borrow";
