import { InvoicesListPage } from "@figma-compare/pages/app/InvoicesPage";

type AppInvoicesPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstSearchParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

export default async function AppInvoicesPage({ searchParams }: AppInvoicesPageProps) {
  const params = (await searchParams) || {};
  const initialSearch = firstSearchParam(params.q) || firstSearchParam(params.search);

  return <InvoicesListPage initialSearch={initialSearch} />;
}
