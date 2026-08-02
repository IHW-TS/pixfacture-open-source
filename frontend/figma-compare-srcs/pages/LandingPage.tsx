import { Navbar } from "../components/landing/Navbar";
import { Hero } from "../components/landing/Hero";
import { ProblemSolution } from "../components/landing/ProblemSolution";
import { Features } from "../components/landing/Features";
import { HowItWorks } from "../components/landing/HowItWorks";
import { TechBand } from "../components/landing/TechBand";
import { ProductOverview } from "../components/landing/ProductOverview";
import { Security } from "../components/landing/Security";
import { Pricing } from "../components/landing/Pricing";
import { ReformTimeline } from "../components/landing/ReformTimeline";
import { FAQ } from "../components/landing/FAQ";
import { FinalCTA } from "../components/landing/FinalCTA";
import { Footer } from "../components/landing/Footer";
import { SectionNav } from "../components/landing/SectionNav";

export function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden" style={{ background: "#070d1a" }}>
      <Navbar />
      <SectionNav />
      <main>
        <Hero />
        <ProblemSolution />
        <Features />
        <HowItWorks />
        <TechBand />
        <ProductOverview />
        <Security />
        <Pricing />
        <ReformTimeline />
        <FAQ />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}
