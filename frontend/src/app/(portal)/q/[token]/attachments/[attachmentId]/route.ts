import { apiOrigin } from "@/lib/api";

export async function GET(request: Request, { params }: { params: Promise<{ token: string; attachmentId: string }> }) {
  const { token, attachmentId } = await params;

  const url = new URL(request.url);
  const download = url.searchParams.get("download") === "1";

  const upstream = new URL(
    `${apiOrigin}/api/public/quotes/${encodeURIComponent(token)}/attachments/${encodeURIComponent(attachmentId)}/file`,
  );
  if (download) upstream.searchParams.set("download", "1");

  const headers: Record<string, string> = {};
  const range = request.headers.get("range");
  if (range) headers["range"] = range;

  const res = await fetch(upstream.toString(), {
    headers,
    cache: "no-store",
  });

  const outHeaders = new Headers();
  [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
    "content-disposition",
  ].forEach((h) => {
    const v = res.headers.get(h);
    if (v) outHeaders.set(h, v);
  });

  outHeaders.set("cache-control", "no-store");

  return new Response(res.body, {
    status: res.status,
    headers: outHeaders,
  });
}
