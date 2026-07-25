import { createItemHandlers } from "@/lib/crud";

const handlers = createItemHandlers({
  collection: "units",
  dataType: "Unit",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `Abbr: ${d.symbol ?? ""} · ${d.type ?? ""}`,
});

export const { PATCH, DELETE } = handlers;
