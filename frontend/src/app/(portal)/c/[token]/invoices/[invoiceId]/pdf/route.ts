import { fetchServerResponse } from "@/lib/serverApi";
import { proxiedDownloadHeaders, upstreamHeaders } from "@/lib/routeProxy";

export async function GET(request: Request, { params }: { params: Promise<{ token: string; invoiceId: string }> }) {
  const { token, invoiceId } = await params;
  const upstreamPath = `/api/public/customers/${encodeURIComponent(token)}/invoices/${encodeURIComponent(invoiceId)}/pdf`;
  const result = await fetchServerResponse(upstreamPath, {
    method: "GET",
    headers: upstreamHeaders(request, "application/pdf"),
  });

  if (!result.response) {
    return new Response("Document indisponible", { status: 502 });
  }

  if (!result.ok) {
    return new Response("Document indisponible", { status: result.status || 500 });
  }

  const headers = proxiedDownloadHeaders(result.response, "application/pdf", 'inline; filename="document.pdf"');
  return new Response(result.response.body, { status: result.status || 200, headers });
}
