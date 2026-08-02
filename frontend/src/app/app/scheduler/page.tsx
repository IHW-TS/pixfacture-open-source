import { redirect } from "next/navigation";
import { SchedulerPage } from "@figma-compare/pages/app/AdvancedPages";
import { shouldShowAdvancedNavigation } from "@/lib/appNavigation";

export default function AppSchedulerPage() {
  if (!shouldShowAdvancedNavigation()) {
    redirect("/app/dashboard");
  }

  return <SchedulerPage />;
}
