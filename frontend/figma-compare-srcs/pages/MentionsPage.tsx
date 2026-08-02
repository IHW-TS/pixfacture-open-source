import { ExternalLink } from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import { LegalPageShell, LegalSection, LegalCallout } from "../components/landing/LegalPageShell";

const PLACEHOLDER = (label: string) => (
  <span className="inline-block bg-amber-100 text-amber-800 text-[11px] px-2 py-0.5 rounded">[{label}]</span>
);

export function MentionsPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Légal"
        title="Mentions légales"
        subtitle="Conformément à la loi n°2004-575 du 21 juin 2004 pour la Confiance dans l'Économie Numérique (LCEN)."
        version="À compléter"
        lastUpdated="À compléter"
      >
        <LegalCallout type="warning">
          Configuration légale incomplète — les champs marqués [à compléter] doivent être renseignés via les variables d'environnement légales du service (NEXT_PUBLIC_LEGAL_*).
        </LegalCallout>

        <LegalSection id="editeur" title="Éditeur du site">
          <div className="grid sm:grid-cols-2 gap-4 mt-2">
            {[
              { label: "Raison sociale", value: PLACEHOLDER("NEXT_PUBLIC_LEGAL_COMPANY_NAME") },
              { label: "Forme juridique", value: PLACEHOLDER("NEXT_PUBLIC_LEGAL_COMPANY_LEGAL_FORM") },
              { label: "Capital social", value: PLACEHOLDER("NEXT_PUBLIC_LEGAL_COMPANY_CAPITAL") },
              { label: "Adresse du siège", value: PLACEHOLDER("NEXT_PUBLIC_LEGAL_COMPANY_ADDRESS") },
              { label: "RCS", value: PLACEHOLDER("NEXT_PUBLIC_LEGAL_COMPANY_RCS") },
              { label: "TVA intracommunautaire", value: PLACEHOLDER("NEXT_PUBLIC_LEGAL_COMPANY_VAT_NUMBER") },
              { label: "Email légal", value: PLACEHOLDER("NEXT_PUBLIC_LEGAL_COMPANY_EMAIL") },
            ].map((item, i) => (
              <div key={i} className="flex flex-col gap-1 py-2 border-b border-slate-100 sm:flex-row sm:items-start sm:gap-3">
                <span className="w-auto shrink-0 text-[13px] text-slate-400 sm:w-44">{item.label}</span>
                <span className="min-w-0 break-words text-[13px] text-slate-700">{item.value}</span>
              </div>
            ))}
          </div>
        </LegalSection>

        <LegalSection id="directeur" title="Directeur de publication / Responsable">
          <p>Directeur de publication : {PLACEHOLDER("NEXT_PUBLIC_LEGAL_PUBLISHER_DIRECTOR")}</p>
        </LegalSection>

        <LegalSection id="contact" title="Contact">
          <p><strong>Email support</strong> : {PLACEHOLDER("NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL")}</p>
          <p className="mt-2">Pour toute question relative au traitement de vos données personnelles :</p>
          <p><strong>Contact RGPD / DPO</strong> : {PLACEHOLDER("NEXT_PUBLIC_LEGAL_DPO_EMAIL")}</p>
        </LegalSection>

        <LegalSection id="hebergeur" title="Hébergeur">
          <div className="space-y-2 text-[14px]">
            <p><strong>Hébergeur de l'instance</strong></p>
            <p>2 rue Kellermann — 59100 Roubaix — France</p>
            <p>
              <a href="https://www.ovhcloud.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-700 underline underline-offset-2">
                ovhcloud.com <ExternalLink size={12} />
              </a>
            </p>
          </div>
          <p className="mt-3 text-[13px] text-slate-500">Hébergement applicatif et bases de données en UE/EEE selon configuration. Sous-traitant au sens du RGPD — voir la <a href="/legal/dpa" className="text-blue-700 underline underline-offset-2">DPA</a>.</p>
        </LegalSection>

        <LegalSection id="propriete" title="Propriété intellectuelle">
          <p>Le logiciel, sa marque et sa documentation restent la propriété exclusive de l'Éditeur. Toute reproduction, modification ou exploitation hors du cadre contractuel est interdite.</p>
        </LegalSection>

        <LegalSection id="notice" title="Avertissement">
          <p>Ce service ne remplace pas un conseil juridique/comptable. Information générale : ne constitue pas un conseil juridique, comptable ou fiscal. La conformité dépend de votre situation (TVA, opérations, secteurs) et des textes applicables. Les spécifications techniques évoluent (se référer à <a href="https://www.impots.gouv.fr" target="_blank" rel="noopener noreferrer" className="text-blue-700 underline underline-offset-2">impots.gouv.fr</a>).</p>
        </LegalSection>

        <LegalSection id="non-pdp" title="Positionnement e-facturation">
          <p>Ce service est un <strong>logiciel de facturation B2B</strong> — il n'est pas une plateforme agréée (PA, ex‑PDP) immatriculée par l'État. La transmission réglementaire passe par une plateforme agréée choisie et contractualisée par le Client.</p>
          <p className="mt-2">
            <a href="https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2">
              Consulter la liste officielle des plateformes agréées (PA, ex‑PDP) <ExternalLink size={11} />
            </a>
          </p>
        </LegalSection>
      </LegalPageShell>
    </LegalLayout>
  );
}
