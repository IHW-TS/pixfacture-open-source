import { redirect } from "next/navigation";
import { TasksPage } from "@figma-compare/pages/app/AdvancedPages";
import { shouldShowAdvancedNavigation } from "@/lib/appNavigation";

export default function AppTasksPage() {
  if (!shouldShowAdvancedNavigation()) {
    redirect("/app/dashboard");
  }

  return <TasksPage />;
}
