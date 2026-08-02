import { fetchServerResponse } from "@/lib/serverApi";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const result = await fetchServerResponse(`/api/public/quotes/${encodeURIComponent(token)}/bundle.zip`, {
    method: "GET",
    headers: {
      Accept: "application/zip,application/octet-stream,*/*",
    },
  });
  if (!result.response) {
    return new Response("Document indisponible", { status: 502 });
  }

  const headers = new Headers();
  const pass = ["content-type", "content-length", "content-disposition", "etag", "cache-control"];
  for (const k of pass) {
    const v = result.response.headers.get(k);
    if (v) headers.set(k, v);
  }

  return new Response(result.response.body, { status: result.status || 200, headers });
}
