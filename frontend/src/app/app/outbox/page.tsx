import { redirect } from "next/navigation";
import { OutboxPage } from "@figma-compare/pages/app/AdvancedPages";
import { shouldShowAdvancedNavigation } from "@/lib/appNavigation";

export default function AppOutboxPage() {
  if (!shouldShowAdvancedNavigation()) {
    redirect("/app/dashboard");
  }

  return <OutboxPage />;
}
