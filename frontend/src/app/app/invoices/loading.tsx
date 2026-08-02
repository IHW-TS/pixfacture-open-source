import { SkeletonPage } from "@/figma/app/components/app/Feedback";

export default function InvoicesLoading() {
  return <SkeletonPage statCards={3} tableRows={8} />;
}
