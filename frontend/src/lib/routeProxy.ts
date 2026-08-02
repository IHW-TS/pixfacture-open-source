import "server-only";

const STREAM_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "accept-ranges",
  "content-range",
  "etag",
  "last-modified",
  "cache-control",
];

export function upstreamHeaders(request: Request, accept: string) {
  const headers: Record<string, string> = { Accept: accept };
  const range = request.headers.get("range");
  if (range) headers.Range = range;
  return headers;
}

export function proxiedDownloadHeaders(
  response: Response,
  fallbackContentType: string,
  fallbackContentDisposition: string,
) {
  const headers = new Headers();
  for (const key of STREAM_HEADERS) {
    const value = response.headers.get(key);
    if (value) headers.set(key, value);
  }
  if (!headers.has("Content-Type")) headers.set("Content-Type", fallbackContentType);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  if (!headers.has("Content-Disposition")) headers.set("Content-Disposition", fallbackContentDisposition);
  return headers;
}
