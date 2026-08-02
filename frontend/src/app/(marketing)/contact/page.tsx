import { createMarketingMetadata } from "@/lib/metadata";
import { redirect } from "next/navigation";
import ContactClientPage from "./ContactClientPage";

export const metadata = createMarketingMetadata({
  title: "Contact",
  description: "Parlez-nous de votre projet facturation et conformité.",
  path: "/contact",
  canonicalPath: "/contact",
  index: true,
});

type ContactPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ContactPage({ searchParams }: ContactPageProps) {
  const resolvedSearchParams = (await searchParams) || {};
  const request = resolvedSearchParams.request;
  const requestedFlow = String(Array.isArray(request) ? request[0] || "" : request || "")
    .trim()
    .toLowerCase();
  if (requestedFlow === "demo") {
    redirect("/app/register?plan=pro");
  }
  return <ContactClientPage />;
}
