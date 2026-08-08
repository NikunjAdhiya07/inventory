import { createCrudHandlers } from "@/lib/crud";

const handlers = createCrudHandlers({
  collection: "departments",
  dataType: "Department",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => [d.code, d.contact].filter(Boolean).join(" · ") || "Department",
  sort: { order: 1, name: 1 },
});

export const { GET, POST } = handlers;
