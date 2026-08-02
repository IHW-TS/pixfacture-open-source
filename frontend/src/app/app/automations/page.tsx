import { redirect } from "next/navigation";
import { AutomationsPage } from "@figma-compare/pages/app/AdvancedPages";
import { shouldShowAdvancedNavigation } from "@/lib/appNavigation";

export default function AppAutomationsPage() {
  if (!shouldShowAdvancedNavigation()) {
    redirect("/app/dashboard");
  }

  return <AutomationsPage />;
}
