"use client";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import {
  LegalPageShell,
  LegalSection,
  LegalSubSection,
  LegalCallout,
  LegalTable,
} from "../components/landing/LegalPageShell";
import { formatSubprocessorDate } from "@/lib/subprocessors";
import { FALLBACK_LEGAL_VARIABLES, type LegalPageProps } from "./legalVariablesFallback";

const sections = [
  { title: "Parties & rôles", anchor: "parties" },
  { title: "Objet et durée", anchor: "objet" },
  { title: "Instructions documentées", anchor: "instructions" },
  { title: "Confidentialité", anchor: "confidentialite" },
  { title: "Sécurité (Annexe 2 — TOMs)", anchor: "securite" },
  { title: "Prestataires et destinataires (Annexe 3)", anchor: "sous-traitants" },
  { title: "Assistance", anchor: "assistance" },
  { title: "Violation de données", anchor: "violation" },
  { title: "Audit", anchor: "audit" },
  { title: "Sort des données", anchor: "sort" },
  { title: "Transferts hors EEE", anchor: "transferts" },
  { title: "Annexe 1 — Description", anchor: "annexe1" },
];

export function DpaPage({ legalVariables = FALLBACK_LEGAL_VARIABLES }: LegalPageProps) {
  const legal = legalVariables;
  const company = legal.company;
  const supportEmail = legal.company.supportEmail;
  const rgpdEmail = legal.rgpdContact.email;
  const configuredDpaVersion = legal.docVersions.dpa;
  const dpaVersion = configuredDpaVersion || "—";
  const dpaLastUpdated = configuredDpaVersion || legal.company.legalLastUpdatedISO || "—";
  const subprocessorsLastUpdated =
    formatSubprocessorDate(legal.subprocessorsLastUpdated || dpaLastUpdated) || dpaLastUpdated;
  const companyIdentity = [
    `${company.companyName.toLocaleUpperCase("fr-FR")}, ${company.legalForm}`,
    company.capital ? `au capital de ${company.capital}` : "",
    `RCS ${company.rcsCity} ${company.rcsNumber}`,
    `TVA ${company.vatNumber}`,
    `siège social : ${company.address}`,
  ]
    .filter(Boolean)
    .join(", ");
  const subprocessorRows = legal.subprocessors.map((item) => {
    const safeguardStatus = item.safeguards
      ? item.optional
        ? `Mécanisme annoncé par le fournisseur, à vérifier contractuellement avant activation : ${item.safeguards}`
        : `Mécanisme annoncé par le fournisseur, à archiver et tenir à jour dans le dossier contractuel : ${item.safeguards}`
      : "Garanties à vérifier et documenter dans le contrat applicable avant activation";
    return [
      item.name,
      item.relationship || "Sous-traitant ultérieur",
      `${item.purpose}${item.optional ? " (selon activation)" : ""}`,
      item.location || "À confirmer selon contrat",
      safeguardStatus,
    ];
  });

  return (
    <LegalLayout>
      <LegalPageShell
        badge="Document contractuel"
        title="Accord de sous-traitance RGPD (DPA)"
        subtitle="Accord de sous-traitance RGPD construit autour des exigences de l'article 28. Il encadre les traitements réalisés par l'Éditeur pour le compte du Client, selon le contrat applicable."
        version={dpaVersion}
        lastUpdated={dpaLastUpdated}
        sections={sections}
      >
        <LegalCallout type="important">
          Ce DPA s'applique pendant la durée du contrat principal, puis selon les obligations légales applicables. En
          cas de contradiction, le présent DPA prévaut pour les traitements de données personnelles.
        </LegalCallout>

        <LegalSection id="parties" title="Parties & rôles">
          <LegalTable
            headers={["Partie", "Rôle", "Définition"]}
            rows={[
              [
                "Client",
                "Responsable du traitement",
                "Entité professionnelle souscrivant au Service, qui détermine les finalités et moyens du traitement.",
              ],
              [
                `${company.companyName.toLocaleUpperCase("fr-FR")} (Éditeur)`,
                "Sous-traitant",
                `${companyIdentity}, traitant les données pour le compte du Client sur instructions documentées.`,
              ],
            ]}
          />
          <div className="mt-4 space-y-3">
            <LegalSubSection title="Définitions clés">
              <ul className="space-y-1.5">
                <li>
                  <strong>Données personnelles</strong> : toute information se rapportant à une personne physique
                  identifiée ou identifiable.
                </li>
                <li>
                  <strong>Sous-traitant ultérieur</strong> : prestataire intervenant pour le compte de l'Éditeur (voir
                  Annexe 3).
                </li>
                <li>
                  <strong>Service</strong> : solution SaaS de facturation et d'exports. Lorsque le mode connecté est
                  contractuellement et techniquement activé, le Service peut échanger avec une plateforme agréée (PA,
                  ex‑PDP) sans devenir lui-même une PA.
                </li>
              </ul>
            </LegalSubSection>
          </div>
        </LegalSection>

        <LegalSection id="objet" title="Objet et durée">
          <p>
            Le présent accord encadre le traitement des données personnelles réalisé par l'Éditeur pour le compte du
            Client dans le cadre de la fourniture du Service (logiciel de facturation B2B).
          </p>
          <p>
            Il s'applique pendant la durée du contrat principal. À son terme, les données métier traitées pour le compte
            du Client sont restituées ou supprimées selon ses instructions, sauf si le droit de l’Union ou d’un État
            membre impose spécifiquement à l’Éditeur de les conserver. Les obligations fiscales ou comptables du Client
            ne créent pas, à elles seules, une obligation de conservation à la charge de l’Éditeur. L’Éditeur conserve
            séparément ses propres pièces fiscales et comptables liées à l’abonnement PixFacture pendant les durées qui
            lui sont légalement applicables.
          </p>
        </LegalSection>

        <LegalSection id="instructions" title="Instructions documentées">
          <p>
            L'Éditeur traite les données personnelles uniquement sur instructions documentées du Client, y compris pour
            les éventuels transferts hors EEE.
          </p>
          <p>
            Si une instruction imposée par le Client est contraire au RGPD ou à d'autres dispositions légales
            applicables, l'Éditeur en informe le Client sans délai.
          </p>
          <p>
            L’activation volontaire d’un connecteur Seqino ou Chorus constitue une instruction documentée limitée à la
            préparation, la transmission, la réception et au suivi des flux activés. Elle ne remplace ni le mandat
            réglementaire ou contractuel requis, ni les conditions propres à la plateforme concernée. Seul un
            représentant habilité du Client peut accepter le mandat depuis l’espace d’administration.
          </p>
        </LegalSection>

        <LegalSection id="confidentialite" title="Confidentialité">
          <p>
            Le personnel habilité de l'Éditeur est soumis à une obligation de confidentialité (contractuelle ou légale)
            et n'accède aux données personnelles que dans la stricte limite du besoin pour accomplir sa mission.
          </p>
        </LegalSection>

        <LegalSection id="securite" title="Sécurité — Annexe 2 (Mesures techniques et organisationnelles)">
          <p>
            L'Éditeur met en place des mesures techniques et organisationnelles appropriées (TOMs) pour assurer un
            niveau de sécurité adapté au risque :
          </p>
          <div className="grid sm:grid-cols-2 gap-2 mt-3">
            {[
              "Chiffrement des flux en transit (TLS)",
              "Segmentation logique par entreprise et isolation des données",
              "Contrôle des accès (RBAC) et moindre privilège",
              "Journalisation et traces techniques avec minimisation des données",
              "Sauvegardes et procédures de restauration",
              "Gestion des correctifs et vulnérabilités",
              "Gestion des secrets et rotation si applicable",
              "Double authentification disponible selon configuration",
              "Monitoring et détection d'incidents",
              "Tests automatisés (CI) et durcissement des headers applicatifs",
            ].map((item, i) => (
              <div key={i} className="flex items-start gap-2 text-[13px]">
                <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
                {item}
              </div>
            ))}
          </div>
          <p className="mt-3 text-[13px] text-slate-500">
            Pour le détail complet, consulter la{" "}
            <a href="/security" className="text-blue-700 underline underline-offset-2">
              page sécurité
            </a>
            .
          </p>
        </LegalSection>

        <LegalSection id="sous-traitants" title="Prestataires techniques et destinataires — Annexe 3">
          <p>
            La liste des sous-traitants ultérieurs est maintenue à jour. Le Client est informé de toute modification
            significative et peut s'opposer pour motif légitime dans un délai raisonnable. En cas d'opposition, les
            parties recherchent une solution alternative ou peuvent convenir de la résiliation de la fonctionnalité
            concernée.
          </p>
          <p>
            Certains organismes peuvent intervenir comme destinataires ou opérateurs indépendants et non comme
            sous-traitants au sens de l’article 28 du RGPD. C’est notamment le cas potentiel de l’AIFE pour Chorus Pro
            via PISTE ; la qualification dépend du flux et des textes applicables.
          </p>
          <LegalTable
            headers={["Nom", "Qualification", "Finalité", "Localisation", "Garanties"]}
            rows={subprocessorRows}
          />
          <p className="text-[12px] text-slate-600 mt-2">
            Dernière mise à jour : {subprocessorsLastUpdated}. Cette liste peut évoluer ; notification via email en cas
            de changement substantiel.
          </p>
        </LegalSection>

        <LegalSection id="assistance" title="Assistance">
          <p>L'Éditeur fournit une assistance raisonnable au Client pour :</p>
          <ul className="space-y-1.5 pl-2 mt-2">
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Les demandes d'exercice de droits des personnes concernées (accès, rectification, suppression,
              portabilité, opposition, limitation).
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              La réalisation d'une analyse d'impact relative à la protection des données (DPIA) si nécessaire.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Les mesures de sécurité et la gestion des incidents.
            </li>
          </ul>
          <p className="mt-3">
            Contact support public :{" "}
            <a href={`mailto:${supportEmail}`} className="text-blue-700 underline underline-offset-2">
              {supportEmail}
            </a>
            .
          </p>
        </LegalSection>

        <LegalSection id="violation" title="Violation de données">
          <p>
            L'Éditeur notifie le Client <strong>sans délai indu</strong> après la découverte d'une violation de données
            personnelles, au plus tard dans les délais légaux applicables.
          </p>
          <p>La notification comprend, dans la mesure du possible :</p>
          <ul className="space-y-1 pl-2 mt-2">
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              La nature de l'incident et les catégories de données concernées.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Le nombre approximatif de personnes et d'enregistrements concernés.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Les impacts potentiels et les mesures correctives prises ou envisagées.
            </li>
          </ul>
          <p className="mt-3">
            Il appartient ensuite au Client (Responsable du traitement) de notifier la CNIL si la violation est
            susceptible d'engendrer un risque pour les droits et libertés des personnes.
          </p>
        </LegalSection>

        <LegalSection id="audit" title="Audit">
          <p>Le Client peut auditer l'Éditeur dans des conditions raisonnables :</p>
          <ul className="space-y-1 pl-2 mt-2">
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Préavis raisonnable (typiquement 30 jours sauf urgence).
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Périmètre limité aux données et traitements couverts par ce DPA.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Respect des obligations de confidentialité.
            </li>
          </ul>
          <p className="mt-3">Les coûts excessifs ou répétés peuvent être à la charge du Client.</p>
        </LegalSection>

        <LegalSection id="sort" title="Sort des données en fin de contrat">
          <p>
            Au terme du contrat, l'Éditeur procède, au choix du Client, à la restitution ou à la suppression des données
            personnelles traitées pour son compte,{" "}
            <strong>
              sauf si le droit de l’Union ou d’un État membre impose spécifiquement à l’Éditeur de les conserver
            </strong>
            . Les obligations de conservation propres au Client ne justifient pas, à elles seules, une conservation
            supplémentaire par l’Éditeur.
          </p>
          <p>
            Une restitution supplémentaire (export ZIP) peut être fournie sur demande dans un délai raisonnable (ex. 30
            jours après résiliation). Les données personnelles dans les journaux techniques sont masquées. Les pièces
            fiscales et comptables émises ou reçues par l’Éditeur pour facturer l’abonnement PixFacture sont distinctes
            des données métier du Client et restent conservées selon les obligations propres à l’Éditeur.
          </p>
        </LegalSection>

        <LegalSection id="transferts" title="Transferts hors EEE">
          <p>
            Par défaut, les données sont hébergées via <strong>{legal.hosting.label}</strong>.
          </p>
          <p>
            Avant tout transfert hors EEE, l’Éditeur identifie et documente le pays, le destinataire et le mécanisme
            juridique effectivement applicable au contrat concerné. Le transfert n’est activé que si les garanties
            requises ont été vérifiées, par exemple une décision d’adéquation, le cadre UE–États-Unis lorsqu’il est
            applicable ou des <strong>clauses contractuelles types (SCC)</strong> complétées, si nécessaire, par des
            mesures additionnelles. La seule mention d’un fournisseur ou d’une SCC dans cette page ne prouve pas qu’elle
            est en vigueur pour le contrat du Client.
          </p>
          <LegalCallout type="info">
            {legal.rgpdContact.label} :{" "}
            {rgpdEmail ? (
              <a href={`mailto:${rgpdEmail}`} className="text-blue-700 underline underline-offset-2">
                {rgpdEmail}
              </a>
            ) : (
              "via le support public"
            )}
            . Objet : demandes RGPD, exercice des droits, incidents.
          </LegalCallout>
        </LegalSection>

        <LegalSection id="annexe1" title="Annexe 1 — Description des traitements">
          <LegalSubSection title="Finalités du traitement">
            <ul className="space-y-1">
              {[
                "Facturation et gestion des clients",
                "Génération de documents (PDF, Factur‑X) et exports",
                "Support client et assistance technique",
                "Sécurité, prévention des abus, journalisation et audit",
              ].map((f, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
          </LegalSubSection>
          <LegalSubSection title="Catégories de données">
            <ul className="space-y-1">
              {[
                "Identités et coordonnées professionnelles (utilisateurs, contacts)",
                "Données de facturation (clients, fournisseurs, montants, références)",
                "Données potentiellement personnelles dans les factures et documents joints",
                "Logs techniques (identifiants, adresses IP, événements de sécurité)",
              ].map((d, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
                  {d}
                </li>
              ))}
            </ul>
          </LegalSubSection>
          <LegalSubSection title="Personnes concernées">
            <ul className="space-y-1">
              {[
                "Employés et utilisateurs du Client",
                "Clients et fournisseurs du Client",
                "Utilisateurs finaux habilités par le Client",
              ].map((p, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
                  {p}
                </li>
              ))}
            </ul>
          </LegalSubSection>
          <LegalSubSection title="Durée">
            <p>
              Données métier : pendant le contrat, puis restitution ou suppression selon les instructions du Client,
              sauf obligation légale imposant spécifiquement leur conservation à l’Éditeur. Les pièces propres à la
              facturation de l’abonnement PixFacture sont traitées séparément selon les obligations de l’Éditeur.
            </p>
          </LegalSubSection>
        </LegalSection>

        <div className="mt-10 pt-6 border-t border-slate-100 flex flex-wrap gap-4">
          <a
            href="/legal/terms"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            CGU/CGV <ExternalLink size={11} />
          </a>
          <a
            href="/legal/privacy"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            Politique de confidentialité <ExternalLink size={11} />
          </a>
          <a
            href="/security"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            Page sécurité <ExternalLink size={11} />
          </a>
          <a
            href="https://www.cnil.fr"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
          >
            CNIL.fr <ExternalLink size={11} />
          </a>
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}
