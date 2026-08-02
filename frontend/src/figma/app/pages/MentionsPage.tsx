"use client";
import { ExternalLink } from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import { LegalPageShell, LegalSection } from "../components/landing/LegalPageShell";
import { FALLBACK_LEGAL_VARIABLES, type LegalPageProps } from "./legalVariablesFallback";

const formatLegalDate = (value: string) => {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
};

export function MentionsPage({ legalVariables = FALLBACK_LEGAL_VARIABLES }: LegalPageProps) {
  const legal = legalVariables;
  const company = legal.company;
  const rcsLabel = [company.rcsCity, company.rcsNumber].filter(Boolean).join(" ");
  const lastUpdated = formatLegalDate(company.legalLastUpdatedISO);
  const version = legal.docVersions.terms || "En vigueur";

  return (
    <LegalLayout>
      <LegalPageShell
        badge="Légal"
        title="Mentions légales"
        subtitle="Conformément à la loi n°2004-575 du 21 juin 2004 pour la Confiance dans l'Économie Numérique (LCEN)."
        version={version}
        lastUpdated={lastUpdated}
      >
        <LegalSection id="editeur" title="Éditeur du site">
          <div className="grid sm:grid-cols-2 gap-4 mt-2">
            {[
              { label: "Raison sociale", value: company.companyName },
              { label: "Forme juridique", value: company.legalForm },
              { label: "Capital social", value: company.capital || "Non communiqué" },
              { label: "Adresse du siège", value: company.address },
              { label: "RCS", value: rcsLabel || "Non communiqué" },
              { label: "TVA intracommunautaire", value: company.vatNumber },
              { label: "Email légal", value: company.email },
              { label: "Téléphone", value: company.phone },
            ].map((item, i) => (
              <div
                key={i}
                className="flex flex-col gap-1 py-2 border-b border-slate-100 sm:flex-row sm:items-start sm:gap-3"
              >
                <span className="w-auto shrink-0 text-[13px] text-slate-600 sm:w-44">{item.label}</span>
                <span className="min-w-0 break-words text-[13px] text-slate-700">{item.value}</span>
              </div>
            ))}
          </div>
        </LegalSection>

        <LegalSection id="directeur" title="Directeur de publication / Responsable">
          <p>Directeur de publication : {company.publisherDirector || company.companyName}</p>
        </LegalSection>

        <LegalSection id="contact" title="Contact">
          <p>
            <strong>Email support</strong> : {company.supportEmail}
          </p>
          <p className="mt-2">Pour toute question relative au traitement de vos données personnelles :</p>
          <p>
            <strong>{legal.rgpdContact.label}</strong> : {legal.rgpdContact.email}
          </p>
        </LegalSection>

        <LegalSection id="hebergeur" title="Hébergeur">
          <div className="space-y-2 text-[14px]">
            <p>
              <strong>{legal.hosting.provider}</strong>
            </p>
            <p>{company.hostingProviderAddress}</p>
            <p>
              <strong>Téléphone</strong> : {company.hostingProviderPhone}
            </p>
          </div>
          <p className="mt-3 text-[13px] text-slate-500">
            Localisation d'hébergement déclarée pour cette instance : {legal.hosting.location || "selon configuration"}.
            Sous-traitant au sens du RGPD — voir la{" "}
            <a href="/legal/dpa" className="text-blue-700 underline underline-offset-2">
              DPA
            </a>
            .
          </p>
        </LegalSection>

        <LegalSection id="propriete" title="Propriété intellectuelle">
          <p>
            Le logiciel, sa marque et sa documentation restent la propriété exclusive de l'Éditeur. Toute reproduction,
            modification ou exploitation hors du cadre contractuel est interdite.
          </p>
        </LegalSection>

        <LegalSection id="notice" title="Avertissement">
          <p>
            Ce service ne remplace pas un conseil juridique/comptable. Information générale : ne constitue pas un
            conseil juridique, comptable ou fiscal. La conformité dépend de votre situation (TVA, opérations, secteurs)
            et des textes applicables. Les spécifications techniques évoluent (se référer à{" "}
            <a
              href="https://www.impots.gouv.fr"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 underline underline-offset-2"
            >
              impots.gouv.fr
            </a>
            ).
          </p>
        </LegalSection>

        <LegalSection id="non-pdp" title="Positionnement e-facturation">
          <p>
            Ce service est un <strong>logiciel de facturation B2B</strong> — il n'est pas une plateforme agréée (PA,
            ex‑PDP) immatriculée par l'État. La transmission réglementaire passe par une plateforme agréée choisie et
            contractualisée par le Client.
          </p>
          <p className="mt-2">
            <a
              href="https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
            >
              Consulter la liste officielle des plateformes agréées (PA, ex‑PDP) <ExternalLink size={11} />
            </a>
          </p>
        </LegalSection>
      </LegalPageShell>
    </LegalLayout>
  );
}
