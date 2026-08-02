import type { Metadata } from "next";
import { getLegalConfig, isLegalValueMissing } from "@/lib/legalConfig";
import { getSourceCodeUrl } from "@/lib/sourceCode";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const { companyName } = getLegalConfig();
  const displayCompanyName = isLegalValueMissing(companyName) ? "PixFacture" : companyName;
  const sourceCodeUrl = getSourceCodeUrl();

  return (
    <div className="portal-shell">
      <div id="main-content" className="portal-container">
        {children}
      </div>
      <footer className="portal-footer muted small">
        <div>
          Document partagé via {displayCompanyName}. <a href="/legal/mentions">Mentions légales</a> ·{" "}
          <a href="/legal/privacy">Confidentialité</a> ·{" "}
          <a href={sourceCodeUrl} target="_blank" rel="noopener noreferrer">
            Code source
          </a>
        </div>
      </footer>
    </div>
  );
}
