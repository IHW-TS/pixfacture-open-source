import { apiOrigin } from "@/lib/api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string; quoteId: string; attachmentId: string }> },
) {
  const { token, quoteId, attachmentId } = await params;

  const url = new URL(request.url);
  const download = url.searchParams.get("download") === "1" ? "1" : "0";

  const headers: HeadersInit = {};
  const range = request.headers.get("range");
  if (range) headers["range"] = range;

  const upstream = `${apiOrigin}/api/public/customers/${encodeURIComponent(
    token,
  )}/quotes/${encodeURIComponent(quoteId)}/attachments/${encodeURIComponent(attachmentId)}/file?download=${download}`;

  const res = await fetch(upstream, {
    headers,
    cache: "no-store",
  });

  const out = new Headers();
  const pass = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
    "content-disposition",
  ];
  for (const k of pass) {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  }

  return new Response(res.body, {
    status: res.status,
    headers: out,
  });
}
