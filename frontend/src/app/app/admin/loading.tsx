import { SkeletonPage } from "@/figma/app/components/app/Feedback";

export default function AdminLoading() {
  return <SkeletonPage statCards={3} tableRows={6} />;
}
