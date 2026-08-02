import { fetchServerResponse } from "@/lib/serverApi";

const PREVIEW_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; img-src data:; font-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self';",
};

function previewUnavailableResponse() {
  return new Response(
    '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="robots" content="noindex"></head><body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#475569;background:#f8fafc;"><div style="padding:24px;text-align:center;">Aperçu momentanément indisponible.</div></body></html>',
    {
      status: 200,
      headers: PREVIEW_HEADERS,
    },
  );
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await fetchServerResponse(`/api/public/invoices/${encodeURIComponent(token)}/preview.html`, {
    method: "GET",
    headers: { Accept: "text/html" },
  });

  if (!result.response) {
    return previewUnavailableResponse();
  }
  if (!result.ok) {
    return previewUnavailableResponse();
  }

  return new Response(result.response.body, {
    status: 200,
    headers: PREVIEW_HEADERS,
  });
}
