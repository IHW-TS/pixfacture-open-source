export type FetchPageResponse<T> = {
  items: T[];
  total: number | null;
  truncated: boolean;
};

type FetchPageOptions = {
  rawApi: (path: string) => Promise<Response>;
  endpoint: string;
  limit?: number;
  maxItems?: number;
  search?: string;
};

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_ITEMS = 1000;

function totalFromHeaders(response: Response) {
  const raw = response.headers.get("X-Total-Count") || response.headers.get("x-total-count") || "";
  const total = Number(raw);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

export async function fetchPaginatedList<T>({
  rawApi,
  endpoint,
  limit = DEFAULT_LIMIT,
  maxItems = DEFAULT_MAX_ITEMS,
  search,
}: FetchPageOptions): Promise<FetchPageResponse<T>> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const safeMaxItems = Math.max(safeLimit, Math.floor(maxItems));
  const items: T[] = [];
  let total: number | null = null;
  let offset = 0;

  while (items.length < safeMaxItems) {
    const params = new URLSearchParams({
      limit: String(safeLimit),
      offset: String(offset),
    });
    const query = String(search || "").trim();
    if (query) params.set("q", query);

    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await rawApi(`${endpoint}${separator}${params.toString()}`);
    const payload = await response.json().catch(() => (response.ok ? [] : null));
    if (!response.ok) {
      const error = new Error("paginated_fetch_failed") as Error & { response?: Response; payload?: unknown };
      error.response = response;
      error.payload = payload;
      throw error;
    }

    const pageItems = Array.isArray(payload) ? payload : [];
    items.push(...(pageItems as T[]));
    total = totalFromHeaders(response) ?? total;
    if (pageItems.length < safeLimit) break;
    if (total !== null && items.length >= total) break;
    offset += safeLimit;
  }

  return {
    items,
    total,
    truncated: total !== null ? items.length < total : items.length >= safeMaxItems,
  };
}
