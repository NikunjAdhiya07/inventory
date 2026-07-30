import { createCrudHandlers } from "@/lib/crud";

// The reusable attribute definitions behind the Product Master (Size, Grade,
// Colour, …). Products reference these by name; the definition supplies the
// input type and the allowed values so the same attribute is entered the same
// way on every product.
const handlers = createCrudHandlers({
  collection: "productAttributes",
  dataType: "Product Attribute",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `Input type: ${d.inputType ?? "text"}`,
  sort: { order: 1, name: 1 },
});

export const { GET, POST } = handlers;
