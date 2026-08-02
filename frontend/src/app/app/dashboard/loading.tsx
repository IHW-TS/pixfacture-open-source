import { SkeletonPage } from "@/figma/app/components/app/Feedback";

export default function DashboardLoading() {
  return <SkeletonPage statCards={4} tableRows={5} />;
}
