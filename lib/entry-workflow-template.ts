import { randomUUID } from "crypto";
import type { StepInstance } from "./workflow-types";

/** Default name for the Entries-mode Add-to-Stock workflow. */
export const ADD_TO_STOCK_WORKFLOW_NAME = "Data Entry — Add to Stock";

export const ADD_TO_STOCK_WORKFLOW_DESC =
  "Photo/name → confirm exact product → Stock Type → Category → Subcategory → Location → Rack → Shelf → pack quantity (units × capacity) → Review.";

function step(
  type: StepInstance["type"],
  label: string,
  config: StepInstance["config"] = {},
  required = true,
  order = 0
): StepInstance {
  return { instanceId: randomUUID(), type, label, required, order, config };
}

/**
 * Guided stock-entry flow for Entries-mode Telegram groups.
 * Photo recommendations only identify the product; the rest follows the
 * classic stock-entry path ending on a shelf for Visual Rack.
 */
export function buildAddToStockSteps(): StepInstance[] {
  return [
    step("item_capture", "Send a photo or type the product name", { requireImage: false }, true, 1),
    step(
      "stock_type",
      "What kind of stock entry is this?",
      {
        options: ["Add Stock", "Opening Stock"],
        optionValues: ["add-stock", "opening-stock"],
      },
      true,
      2
    ),
    step("category_select", "Select the category:", { dataSource: "categories" }, true, 3),
    step(
      "subcategory_select",
      "Select the subcategory:",
      { dataSource: "categories", filterByCategory: true },
      true,
      4
    ),
    step(
      "location_tree",
      "📍 Choose Location → Rack → Shelf:",
      { dataSource: "locations", flatSelect: false, allowSelectBranch: false },
      true,
      5
    ),
    step(
      "pack_quantity",
      "How is this packed?",
      { numberMin: 1, numberMax: 0, dataSource: "units" },
      true,
      6
    ),
    step("review_confirm", "📋 Review", {}, true, 7),
  ];
}
