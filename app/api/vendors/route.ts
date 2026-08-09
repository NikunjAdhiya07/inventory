import { createCrudHandlers } from "@/lib/crud";

const handlers = createCrudHandlers({
  collection: "vendors",
  dataType: "Vendor",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => [d.code, d.contact, d.phone].filter(Boolean).join(" · ") || "Vendor",
  sort: { order: 1, name: 1 },
});

export const { GET, POST } = handlers;
