import { LandingPage } from "./pages/LandingPage";
import { SecurityPage } from "./pages/SecurityPage";
import { DpaPage } from "./pages/DpaPage";
import { TermsPage } from "./pages/TermsPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { CookiesPage } from "./pages/CookiesPage";
import { MentionsPage } from "./pages/MentionsPage";
import { ConfiancePage } from "./pages/ConfiancePage";
import { FaqPage } from "./pages/FaqPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { FeaturesPage } from "./pages/FeaturesPage";
import { PricingPage } from "./pages/PricingPage";

export const router = [
  { path: "/", Component: LandingPage },

  // Content pages
  { path: "/features", Component: FeaturesPage },
  { path: "/pricing", Component: PricingPage },
  { path: "/faq", Component: FaqPage },

  // Trust & security
  { path: "/security", Component: SecurityPage },
  { path: "/confiance", Component: ConfiancePage },

  // Legal
  { path: "/legal/dpa", Component: DpaPage },
  { path: "/legal/terms", Component: TermsPage },
  { path: "/legal/privacy", Component: PrivacyPage },
  { path: "/legal/cookies", Component: CookiesPage },
  { path: "/legal/mentions", Component: MentionsPage },

  // Aliases
  { path: "/legal/cgv", Component: TermsPage },
  { path: "/legal/cgu", Component: TermsPage },
  { path: "/legal/confidentialite", Component: PrivacyPage },
  { path: "/legal/mentions-legales", Component: MentionsPage },

  // Catch-all 404
  { path: "*", Component: NotFoundPage },
] as const;
