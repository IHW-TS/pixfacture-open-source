import { redirect } from "next/navigation";

export default function AdminTenantsRedirect() {
  redirect("/app/admin/tenants");
}
