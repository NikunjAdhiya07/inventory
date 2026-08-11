import { createItemHandlers } from "@/lib/crud";

const handlers = createItemHandlers({
  collection: "plants",
  dataType: "Plant",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => [d.code, d.contact].filter(Boolean).join(" · ") || "Plant",
});

export const { PATCH, DELETE } = handlers;
