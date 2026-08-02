import { SkeletonPage } from "@/figma/app/components/app/Feedback";

export default function CustomersLoading() {
  return <SkeletonPage statCards={4} tableRows={8} />;
}
