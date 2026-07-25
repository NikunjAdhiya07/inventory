import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

// Generic client-side column sort: click a header to sort by that field,
// click again to flip direction. Purely a view transform — never writes
// back to the server, so it composes safely with pages that also have a
// persisted drag-to-reorder "order" field (sorting just overrides the
// on-screen order until reset).
export function useSort<T, K extends keyof T>(rows: T[], initialKey: K | null = null) {
  const [sortKey, setSortKey] = useState<K | null>(initialKey);
  const [dir, setDir] = useState<SortDir>("asc");

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      let cmp: number;
      if (typeof av === "number" && typeof bv === "number") {
        cmp = av - bv;
      } else if (typeof av === "boolean" && typeof bv === "boolean") {
        cmp = Number(av) - Number(bv);
      } else {
        cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
      }
      return dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, dir]);

  function toggleSort(key: K) {
    if (sortKey === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDir("asc");
    }
  }

  function resetSort() {
    setSortKey(null);
    setDir("asc");
  }

  return { sorted, sortKey, dir, toggleSort, resetSort };
}
