import { CheckCircle2, ExternalLink } from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import {
  LegalPageShell,
  LegalSection,
  LegalSubSection,
  LegalCallout,
  LegalTable,
} from "../components/landing/LegalPageShell";
import { formatSubprocessorDate, SUBPROCESSORS_LAST_UPDATED } from "@/lib/subprocessors";

const sections = [
  { title: "Parties & rôles", anchor: "parties" },
  { title: "Objet et durée", anchor: "objet" },
  { title: "Instructions documentées", anchor: "instructions" },
  { title: "Confidentialité", anchor: "confidentialite" },
  { title: "Sécurité (Annexe 2 — TOMs)", anchor: "securite" },
  { title: "Sous-traitants ultérieurs (Annexe 3)", anchor: "sous-traitants" },
  { title: "Assistance", anchor: "assistance" },
  { title: "Violation de données", anchor: "violation" },
  { title: "Audit", anchor: "audit" },
  { title: "Sort des données", anchor: "sort" },
  { title: "Transferts hors EEE", anchor: "transferts" },
  { title: "Annexe 1 — Description", anchor: "annexe1" },
];

const subprocessorsLastUpdated = formatSubprocessorDate(SUBPROCESSORS_LAST_UPDATED) || "21/01/2026";

export function DpaPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Document contractuel"
        title="Accord de sous-traitance RGPD (DPA)"
        subtitle="Modèle d'accord de sous-traitance RGPD construit autour des exigences de l'article 28. Il encadre les traitements réalisés par l'Éditeur pour le compte du Client, selon le contrat applicable."
        version="1.0"
        lastUpdated="2026-01-21"
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
                "Éditeur SaaS",
                "Sous-traitant",
                "Société éditrice du logiciel, traitant les données pour le compte du Client sur instructions documentées.",
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
                  activé, le Service est une solution compatible raccordée à une plateforme agréée (PA, ex‑PDP).
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
            Il s'applique pendant la durée du contrat principal, puis selon les obligations légales applicables (ex.
            conservation fiscale 6 ans, comptable 10 ans).
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

        <LegalSection id="sous-traitants" title="Sous-traitants ultérieurs — Annexe 3">
          <p>
            La liste des sous-traitants ultérieurs est maintenue à jour. Le Client est informé de toute modification
            significative et peut s'opposer pour motif légitime dans un délai raisonnable. En cas d'opposition, les
            parties recherchent une solution alternative ou peuvent convenir de la résiliation de la fonctionnalité
            concernée.
          </p>
          <LegalTable
            headers={["Nom", "Finalité", "Localisation", "Garanties"]}
            rows={[
              [
                "Hébergeur de l'instance",
                "Hébergement applicatif et bases de données",
                "UE/EEE selon configuration",
                "—",
              ],
              [
                "Mailgun (Twilio)",
                "Envoi d'emails transactionnels (notifications, factures)",
                "États-Unis (transfert possible)",
                "SCC (clauses contractuelles types)",
              ],
              ["Stripe", "Paiement en ligne et gestion des abonnements", "Irlande (UE) + États-Unis", "SCC"],
              ["Sentry", "Monitoring applicatif et gestion des erreurs", "UE", "DPA Sentry"],
              [
                "Seqino (plateforme agréée)",
                "Transmission réglementaire via plateforme agréée (PA, ex‑PDP)",
                "France",
                "Obligatoire pour la transmission e‑invoicing via Seqino",
              ],
            ]}
          />
          <p className="text-[12px] text-slate-400 mt-2">
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
          <p className="mt-3">Contact support : communiqué lors de la souscription.</p>
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
            personnelles, <strong>sauf obligation légale de conservation</strong> (ex. factures : conservation fiscale 6
            ans, comptable 10 ans).
          </p>
          <p>
            Une restitution supplémentaire (export ZIP) peut être fournie sur demande dans un délai raisonnable (ex. 30
            jours après résiliation). Les données personnelles dans les journaux techniques sont masquées.
          </p>
        </LegalSection>

        <LegalSection id="transferts" title="Transferts hors EEE">
          <p>
            Par défaut, les données sont hébergées via <strong>l'hébergeur UE/EEE configuré pour l'instance</strong>.
          </p>
          <p>
            Si un transfert hors EEE est requis (ex. certains sous-traitants), des garanties appropriées sont mises en
            place : <strong>clauses contractuelles types (SCC)</strong> approuvées par la Commission Européenne ou
            autres mécanismes conformes au RGPD.
          </p>
          <LegalCallout type="info">
            DPO / Contact RGPD : non communiqué publiquement — contactez-nous via le support pour toute demande relative
            aux données personnelles. Objet : demandes RGPD, exercice des droits, incidents.
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
              Durée du contrat + obligations légales applicables (conservation fiscale 6 ans, comptable 10 ans minimum).
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
