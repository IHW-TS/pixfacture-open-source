import { apiOrigin } from "@/lib/api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string; invoiceId: string; attachmentId: string }> },
) {
  const { token, invoiceId, attachmentId } = await params;

  const url = new URL(request.url);
  const download = url.searchParams.get("download") === "1" ? "1" : "0";

  const upstream = `${apiOrigin}/api/public/customers/${encodeURIComponent(token)}/invoices/${encodeURIComponent(
    invoiceId,
  )}/attachments/${encodeURIComponent(attachmentId)}/file?download=${download}`;

  const headers: Record<string, string> = {};
  const range = request.headers.get("range");
  if (range) headers["range"] = range;

  const res = await fetch(upstream, { headers, cache: "no-store" });

  const outHeaders = new Headers();
  for (const k of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
    "content-disposition",
  ]) {
    const v = res.headers.get(k);
    if (v) outHeaders.set(k, v);
  }

  return new Response(res.body, { status: res.status, headers: outHeaders });
}
