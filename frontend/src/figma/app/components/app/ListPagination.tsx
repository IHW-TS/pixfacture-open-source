"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const DEFAULT_LIST_PAGE_SIZE = 10;
export const LIST_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

export function getListTotalPages(totalItems: number, pageSize = DEFAULT_LIST_PAGE_SIZE) {
  return Math.max(1, Math.ceil(Math.max(0, totalItems) / pageSize));
}

export function paginateList<T>(items: T[], page: number, pageSize = DEFAULT_LIST_PAGE_SIZE) {
  const safePage = Math.min(Math.max(1, page), getListTotalPages(items.length, pageSize));
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

function readStoredPageSize(storageKey: string, options: readonly number[]) {
  const fallback = options[0] || DEFAULT_LIST_PAGE_SIZE;
  if (typeof window === "undefined") return fallback;
  const stored = Number(window.localStorage.getItem(storageKey));
  return options.includes(stored) ? stored : fallback;
}

export function usePersistedListPageSize(storageKey: string, options: readonly number[] = LIST_PAGE_SIZE_OPTIONS) {
  const [pageSize, setPageSizeState] = useState(() => readStoredPageSize(storageKey, options));

  useEffect(() => {
    setPageSizeState(readStoredPageSize(storageKey, options));
  }, [storageKey, options]);

  const setPageSize = useCallback(
    (nextPageSize: number) => {
      if (!options.includes(nextPageSize)) return;
      setPageSizeState(nextPageSize);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(storageKey, String(nextPageSize));
      }
    },
    [storageKey, options],
  );

  return [pageSize, setPageSize] as const;
}

export function ListPagination({
  page,
  totalItems,
  pageSize = DEFAULT_LIST_PAGE_SIZE,
  visibleItemsCount,
  pageSizeOptions,
  itemLabel,
  pluralLabel,
  onPageChange,
  onPageSizeChange,
  pageSizeAriaLabel = "Lignes par page",
  action,
  className = "",
}: {
  page: number;
  totalItems: number;
  pageSize?: number;
  visibleItemsCount?: number;
  pageSizeOptions?: readonly number[];
  itemLabel: string;
  pluralLabel?: string;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeAriaLabel?: string;
  action?: ReactNode;
  className?: string;
}) {
  const totalPages = getListTotalPages(totalItems, pageSize);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const visibleCount =
    typeof visibleItemsCount === "number"
      ? Math.max(0, visibleItemsCount)
      : totalItems === 0
        ? 0
        : Math.min(pageSize, Math.max(0, totalItems - (safePage - 1) * pageSize));
  const shownLabel = visibleCount > 1 ? "affichés" : "affiché";
  const totalLabel = totalItems === 1 ? itemLabel : pluralLabel || `${itemLabel}s`;
  const countLabel = `${visibleCount} ${shownLabel} sur ${totalItems} ${totalLabel}`;

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 border-t border-[#f1f5f9] bg-[#fafbfd] px-4 py-2.5 ${className}`}
    >
      <span className="text-xs text-[#94a3b8]">{countLabel}</span>
      <div className="flex flex-wrap items-center justify-end gap-3">
        {action}
        {pageSizeOptions && pageSizeOptions.length > 0 && onPageSizeChange ? (
          <label
            className="flex items-center gap-2 text-[#64748b]"
            style={{ fontSize: "var(--pf-app-text-caption)", fontWeight: 700 }}
          >
            Par page
            <select
              aria-label={pageSizeAriaLabel}
              value={pageSize}
              onChange={(event) => {
                const nextPageSize = Number(event.target.value);
                if (!pageSizeOptions.includes(nextPageSize)) return;
                onPageSizeChange(nextPageSize);
              }}
              className="h-8 rounded-lg border border-[#e2e8f0] bg-white px-2 text-[#475569] outline-none transition hover:border-[#bfdbfe] focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/15"
              style={{ fontSize: "var(--pf-app-text-body)", fontWeight: 800 }}
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Page précédente"
            onClick={() => onPageChange(Math.max(1, safePage - 1))}
            disabled={safePage <= 1}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#e2e8f0] bg-white text-[#94a3b8] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[#f8fafc] disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="rounded-lg border border-[#e2e8f0] bg-white px-3 py-1.5 text-xs font-medium tabular-nums text-[#475569]">
            {safePage} / {totalPages}
          </span>
          <button
            type="button"
            aria-label="Page suivante"
            onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
            disabled={safePage >= totalPages}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#e2e8f0] bg-white text-[#94a3b8] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:bg-[#f8fafc] disabled:opacity-40"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
