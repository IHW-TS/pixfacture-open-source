import { fetchServerJson } from "@/lib/serverApi";
import { PORTAL_DOCUMENT_UNAVAILABLE } from "@/lib/publicPortalErrors";
import CustomerPortalClient from "./CustomerPortalClient";

export default async function CustomerPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const portalResult = await fetchServerJson(`/api/public/customers/${token}`);

  const initialError = portalResult.ok && portalResult.data ? null : PORTAL_DOCUMENT_UNAVAILABLE;

  return (
    <CustomerPortalClient
      token={token}
      initialData={portalResult.ok ? portalResult.data : null}
      initialError={initialError}
    />
  );
}
