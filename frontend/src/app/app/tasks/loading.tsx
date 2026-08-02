import { SkeletonPage } from "@/figma/app/components/app/Feedback";

export default function TasksLoading() {
  return <SkeletonPage statCards={2} tableRows={6} />;
}
