import { fetchServerResponse } from "@/lib/serverApi";
import { proxiedDownloadHeaders } from "@/lib/routeProxy";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; quoteId: string }> }) {
  const { token, quoteId } = await params;
  const result = await fetchServerResponse(
    `/api/public/customers/${encodeURIComponent(token)}/quotes/${encodeURIComponent(quoteId)}/bundle.zip`,
    {
      method: "GET",
      headers: {
        Accept: "application/zip,application/octet-stream,*/*",
      },
    },
  );
  if (!result.response) {
    return new Response("Document indisponible", { status: 502 });
  }
  const headers = proxiedDownloadHeaders(result.response, "application/zip", 'attachment; filename="documents.zip"');

  return new Response(result.response.body, { status: result.status || 200, headers });
}
