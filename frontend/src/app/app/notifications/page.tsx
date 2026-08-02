import { redirect } from "next/navigation";
import { NotificationsPage } from "@figma-compare/pages/app/AdvancedPages";
import { shouldShowAdvancedNavigation } from "@/lib/appNavigation";

export default function AppNotificationsPage() {
  if (!shouldShowAdvancedNavigation()) {
    redirect("/app/dashboard");
  }

  return <NotificationsPage />;
}
