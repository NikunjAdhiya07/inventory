import { createCrudHandlers } from "@/lib/crud";

const handlers = createCrudHandlers({
  collection: "units",
  dataType: "Unit",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `Abbr: ${d.symbol ?? ""} · ${d.type ?? ""}`,
});

export const { GET, POST } = handlers;
