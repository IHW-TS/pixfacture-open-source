import { redirect } from "next/navigation";
import { createMarketingMetadata } from "@/lib/metadata";

export const metadata = createMarketingMetadata({
  title: "Inscription",
  description: "Redirection vers la création de compte.",
  path: "/register",
  index: false,
});

type RegisterPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const resolvedSearchParams = (await searchParams) || {};
  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(resolvedSearchParams)) {
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (typeof value === "string" && value.trim()) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  redirect(query ? `/app/register?${query}` : "/app/register");
}
