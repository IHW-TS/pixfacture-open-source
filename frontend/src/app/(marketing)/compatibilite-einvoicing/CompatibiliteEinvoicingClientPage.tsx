"use client";

import Link from "next/link";
import { Calendar2026Block } from "@/components/Calendar2026Block";
import ComplianceScopeBlock from "@/components/ComplianceScopeBlock";
import OfficialPdpStatusNote from "@/components/OfficialPdpStatusNote";
import {
  OFFICIAL_B2B_SPECS_URL,
  OFFICIAL_CALENDAR_URL,
  OFFICIAL_PDP_LIST_URL,
  OFFICIAL_SOURCES_LAST_UPDATED,
  OFFICIAL_SOURCES_LAST_UPDATED_LABEL,
} from "@/lib/officialLinks";
import {
  complianceTimeline,
  formatYearRange,
  showSourcesUpdateBanner,
  sourcesLastUpdatedAvailable,
  sourcesUpdateBannerLabel,
} from "@/lib/complianceTimeline";
import { featureFlags } from "@/lib/featureFlags";
import { partnerNameLabel, resolveMarketingClaimLevel, useComplianceMarketingStatus } from "@/lib/einvoicingMarketing";
import { EXPLANATION } from "@/lib/terminology";

const CALENDAR_UPDATED_AT = OFFICIAL_SOURCES_LAST_UPDATED;
const LAST_UPDATED_LABEL = sourcesLastUpdatedAvailable ? OFFICIAL_SOURCES_LAST_UPDATED_LABEL : "";
const timelineRange = formatYearRange(
  complianceTimeline.einvoicing.reception,
  complianceTimeline.einvoicing.emission_pme_micro,
  "-",
);

export default function CompatibiliteEinvoicing() {
  const runtimeStatus = useComplianceMarketingStatus();
  const resolvedClaim = resolveMarketingClaimLevel(undefined, runtimeStatus, featureFlags);
  const partnerName = partnerNameLabel(runtimeStatus, featureFlags);
  const isPartnered = resolvedClaim === "partnered" && Boolean(partnerName);
  const isCompatible = resolvedClaim === "compatible" && !isPartnered;
  const fr2027BadgeLabel = "2027 : en cours / suivi";
  const partnerNote = isPartnered
    ? `${EXPLANATION} ${partnerName} (statut selon liste officielle, mandat requis)`
    : `${EXPLANATION} de votre choix`;
  const complianceTodayConnection = isPartnered
    ? `Via ${partnerNote} : émission + réception + statuts.`
    : isCompatible
      ? `Connexion possible à une ${EXPLANATION} de votre choix : émission + réception + statuts (contrat/mandat requis).`
      : null;
  const positioningConnection = isPartnered
    ? `Connecté via ${partnerNote} pour l'émission/réception et les statuts.`
    : isCompatible
      ? `Connectable à une ${EXPLANATION} pour l'émission/réception et les statuts (contrat/mandat).`
      : `Mode export : dépôt/transmission via votre ${EXPLANATION}.`;
  const connectorsBullet = isPartnered
    ? `Connecteur ${partnerName} vers ${EXPLANATION} (mandat requis).`
    : isCompatible
      ? `Connecteurs vers ${EXPLANATION} de votre choix (contrat/mandat).`
      : `Exports Factur‑X Pro pour dépôt/transmission via ${EXPLANATION} de votre choix.`;

  const complianceToday = [
    "Factur‑X / EN16931 (CII) : export + contrôles avec Pro selon configuration",
    "Exports Factur‑X (PDF + XML) avec Pro pour dépôt/transmission via votre plateforme agréée (PA, ex‑PDP)",
    ...(complianceTodayConnection ? [complianceTodayConnection] : []),
    "E‑reporting en beta Pro selon plateforme agréée, mandat, configuration et périmètre",
    "Canal public (B2G) : connecteur disponible selon besoin",
    "Annuaire interne (manuel + import CSV) pour préparer le routage",
  ];

  const complianceRoadmap = [
    "PPF : annuaire central + concentrateur (interop plateforme agréée (PA, ex‑PDP) ↔ PPF) — suivi des évolutions de la spécification",
    "Connecteurs grands comptes : sur demande (projets d’intégration)",
    "Automatisation e‑reporting (B2C / international) : activation selon périmètre + spécifications publiées",
  ];

  const positioningItems = [
    "Logiciel de facturation B2B pour génération PDF et export Factur‑X / EN16931 avec Pro.",
    positioningConnection,
    "E‑reporting en beta Pro via plateforme agréée ou export selon périmètre.",
    "Conçu pour la conformité, sous réserve de paramétrage et de périmètre.",
    "La conformité d'acheminement dépend de la plateforme agréée (PA, ex‑PDP) choisie, de ses SLA et de ses conditions contractuelles.",
  ];

  return (
    <div className="section mk-prelogin-page mk-prelogin-page--compatibilite">
      <div className="row justify-between items-center">
        <div>
          <h1>Compatibilité e-invoicing {timelineRange || "2026-2027"}</h1>
          <p className="muted max-w-780">
            Nous sommes un logiciel de facturation B2B pour générer des PDF et, avec Pro, contrôler/exporter en Factur‑X
            / EN16931, sous réserve de paramétrage et de périmètre. La transmission réglementaire passe par une
            plateforme agréée (PA, ex‑PDP) immatriculée sélectionnée par le client. Le PPF (portail public) couvre
            l'annuaire central ; l’e‑reporting transite via la plateforme agréée (PA, ex‑PDP) et le PPF selon les flux
            réglementaires.
          </p>
        </div>
        <div className="row gap-6">
          <span className="pill">Compatibilité</span>
          <span className="pill muted">{fr2027BadgeLabel}</span>
        </div>
      </div>

      <ComplianceScopeBlock className="mt-10" />

      <div className="notice mt-10">
        {showSourcesUpdateBanner && sourcesUpdateBannerLabel && (
          <div className="alert-inline warning">{sourcesUpdateBannerLabel}</div>
        )}
        {LAST_UPDATED_LABEL && <b>Dernière mise à jour : {LAST_UPDATED_LABEL}</b>}
        <OfficialPdpStatusNote className="mt-6" />
      </div>

      <div className="row gap-10 flex-wrap mt-10">
        <Link className="btn" href="/app/register">
          Voir les offres
        </Link>
        <Link className="btn secondary" href="/app/einvoicing">
          {isPartnered || isCompatible
            ? "Activer la connexion sponsor (plateforme agréée (PA, ex‑PDP) immatriculée)"
            : "Configurer le mode export (Factur‑X)"}
        </Link>
      </div>

      <div className="card highlight mt-12">
        Chaque entreprise doit choisir sa plateforme agréée (PA, ex‑PDP) immatriculée ; nous sommes un logiciel de
        facturation B2B qui s&apos;y connecte via une activation sponsor gérée par notre SaaS, ou exporte en dépôt
        manuel.
      </div>

      <div className="grid mt-18">
        <Calendar2026Block updatedAt={CALENDAR_UPDATED_AT} />
        <div className="card">
          <h3>PDF simple par email : insuffisant pour les flux réglementaires e-invoicing B2B</h3>
          <p className="muted">
            Une facture électronique doit être structurée (UBL, CII ou Factur-X) et transmise via une plateforme agréée
            (PA, ex‑PDP) immatriculée. Un PDF joint par email ne satisfait pas l'obligation e-invoicing.
          </p>
        </div>
        <div className="card">
          <h3>4 nouvelles mentions obligatoires</h3>
          <ul>
            <li>SIREN du client (si client = entreprise)</li>
            <li>Adresse de livraison (si différente)</li>
            <li>Nature de l'opération : biens / services / mixte</li>
            <li>TVA sur les débits (si applicable)</li>
          </ul>
        </div>
        <div className="card">
          <h3>PPF : annuaire + e-reporting</h3>
          <p className="muted">
            Le PPF (portail public) permet d'identifier la plateforme agréée (PA, ex‑PDP) immatriculée du destinataire
            et les adresses de facturation, et de gérer l'e‑reporting via les flux réglementaires. L’activation dépend
            des flux plateforme agréée (PA, ex‑PDP)/PPF ; l’envoi connecté dépend du mandat, du contrat et de la
            configuration.
          </p>
        </div>
      </div>

      <section className="section" id="ce-que-nous-faisons">
        <div className="section-header">
          <div>
            <h2>Ce que nous faisons / Ce que nous ne faisons pas</h2>
            <p className="muted">Positionnement clair entre OD et plateforme agréée (PA, ex‑PDP).</p>
          </div>
          <span className="pill muted">Positionnement</span>
        </div>
        <div className="grid">
          <div className="card">
            <div className="badge">Ce que nous faisons</div>
            <div className="list-check compact">
              {[
                "Logiciel de facturation B2B pour génération/export Factur‑X / EN16931",
                positioningConnection,
                "Pré-validation avant émission",
                "Contrôle des 4 nouvelles données prévues par la réforme (SIREN, livraison, nature, TVA sur les débits)",
                "Exports et traces techniques",
                connectorsBullet,
              ].map((item, idx) => (
                <div className="check" key={idx}>
                  <span className="check-icon" aria-hidden="true"></span>
                  {item}
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="badge">Ce que nous ne faisons pas</div>
            <ul>
              <li>Nous ne sommes pas une plateforme agréée (PA, ex‑PDP) immatriculée</li>
              <li>Nous ne gérons pas l'immatriculation de plateforme</li>
              <li>Nous ne transmettons pas sans plateforme choisie par l'entreprise</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section" id="statut-conformite">
        <div className="section-header">
          <div>
            <h2>Statut conformité</h2>
            <p className="muted">Disponible aujourd'hui vs roadmap.</p>
          </div>
          <span className="pill muted">Aujourd'hui / Roadmap</span>
        </div>
        <div className="grid">
          <div className="card">
            <div className="badge">Aujourd'hui</div>
            <ul>
              {complianceToday.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="card">
            <div className="badge">Roadmap</div>
            <ul>
              {complianceRoadmap.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="card highlight">
          <div className="badge">Positionnement</div>
          <ul>
            {positioningItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      <div className="notice mt-12">
        <div>
          <b>Sources officielles :</b>{" "}
          <a href={OFFICIAL_CALENDAR_URL} target="_blank" rel="noreferrer">
            calendrier officiel
          </a>{" "}
          -{" "}
          <a href={OFFICIAL_B2B_SPECS_URL} target="_blank" rel="noreferrer">
            spécifications externes B2B (DGFiP)
          </a>{" "}
          -{" "}
          <a href={OFFICIAL_PDP_LIST_URL} target="_blank" rel="noreferrer">
            liste officielle des plateformes agréées (PA, ex‑PDP)
          </a>
        </div>
      </div>
    </div>
  );
}
