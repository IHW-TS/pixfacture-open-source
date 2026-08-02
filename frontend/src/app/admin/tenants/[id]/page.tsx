import { redirect } from "next/navigation";

type Params = { id: string };

type PageProps = {
  params: Promise<Params>;
};

export default async function AdminTenantDetailRedirect({ params }: PageProps) {
  const { id } = await params;
  redirect(`/app/admin/tenants/${id}`);
}
