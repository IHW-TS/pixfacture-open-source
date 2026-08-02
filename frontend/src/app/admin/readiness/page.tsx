import { redirect } from "next/navigation";

export default function AdminReadinessRedirect() {
  redirect("/app/admin/readiness");
}
