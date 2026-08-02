import "@/figma/styles/index-next.css";
import AnalyticsConsent from "@/components/AnalyticsConsent";
import { Navbar } from "@/figma/app/components/landing/Navbar";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  const pd = process.env.PLAUSIBLE_DOMAIN;

  return (
    <>
      <AnalyticsConsent plausibleDomain={pd} />
      <div className="figma-root">
        <Navbar />
        {children}
      </div>
    </>
  );
}
