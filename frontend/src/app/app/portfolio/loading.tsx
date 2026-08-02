import { SkeletonPage } from "@/figma/app/components/app/Feedback";

export default function PortfolioLoading() {
  return <SkeletonPage statCards={4} tableRows={8} />;
}
