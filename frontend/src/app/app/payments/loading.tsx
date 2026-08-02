import { SkeletonPage } from "@/figma/app/components/app/Feedback";

export default function PaymentsLoading() {
  return <SkeletonPage statCards={3} tableRows={6} />;
}
