import { createCrudHandlers } from "@/lib/crud";

const handlers = createCrudHandlers({
  collection: "plants",
  dataType: "Plant",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => [d.code, d.contact].filter(Boolean).join(" · ") || "Plant",
  sort: { order: 1, name: 1 },
});

export const { GET, POST } = handlers;
