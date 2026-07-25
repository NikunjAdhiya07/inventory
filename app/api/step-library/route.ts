import { createCrudHandlers } from "@/lib/crud";

// The step library is a seeded, read-mostly master. GET drives the builder
// palette; POST exists for completeness (adding a new step type is an admin op).
const handlers = createCrudHandlers({
  collection: "stepLibrary",
  dataType: "Step Type",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `Step type: ${d.type ?? ""}`,
  sort: { order: 1 },
});

export const { GET, POST } = handlers;
