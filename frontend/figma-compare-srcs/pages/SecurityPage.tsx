import { Shield, Lock, Server, Database, FileText, BadgeCheck, CheckCircle2, ExternalLink } from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import {
  LegalPageShell,
  LegalSection,
  LegalSubSection,
  LegalCallout,
  LegalTable,
} from "../components/landing/LegalPageShell";

const sections = [
  { title: "Sécurité applicative", anchor: "applicative" },
  { title: "Authentification & accès", anchor: "auth" },
  { title: "Chiffrement", anchor: "chiffrement" },
  { title: "Hébergement & infrastructure", anchor: "hebergement" },
  { title: "Sauvegardes & RPO/RTO", anchor: "sauvegardes" },
  { title: "Sous-traitants", anchor: "sous-traitants" },
  { title: "RGPD & DPA", anchor: "rgpd" },
  { title: "Archivage", anchor: "archivage" },
  { title: "Incidents", anchor: "incidents" },
  { title: "Sources & contacts", anchor: "contacts" },
];

const subprocessors = [
  ["Hébergeur de l'instance", "Hébergement applicatif et bases de données", "UE/EEE selon configuration", "—"],
  [
    "Mailgun (Twilio)",
    "Envoi d'emails transactionnels (notifications, factures)",
    "États-Unis (transfert possible)",
    "SCC",
  ],
  ["Stripe", "Paiement en ligne et gestion des abonnements", "Irlande (UE) + États-Unis", "SCC"],
  ["Sentry", "Monitoring applicatif et gestion des erreurs", "UE", "DPA"],
  [
    "Seqino (PA)",
    "Transmission réglementaire via plateforme agréée (PA, ex‑PDP)",
    "France",
    "Obligatoire pour la transmission e‑invoicing",
  ],
];

export function SecurityPage() {
  return (
    <LegalLayout>
      <LegalPageShell
        badge="Centre de confiance"
        title="Page sécurité"
        subtitle="Auth, chiffrement, sauvegardes, monitoring configurable, logs, hébergement France, RPO/RTO. Ce document présente les mesures techniques et organisationnelles (TOMs) mises en place."
        version="1.0"
        lastUpdated="2026-01-21"
        sections={sections}
      >
        <LegalCallout type="important">
          Ce document est fourni à titre informatif. Les engagements contractuels sont définis dans la DPA et les
          CGU/CGV. Les spécifications peuvent évoluer.
        </LegalCallout>

        <div className="my-8 grid sm:grid-cols-3 gap-4">
          {[
            {
              icon: <Shield size={20} className="text-blue-700" />,
              label: "Hébergement",
              value: "UE/EEE selon instance",
            },
            { icon: <Lock size={20} className="text-blue-700" />, label: "Chiffrement transit", value: "TLS 1.2+" },
            { icon: <Database size={20} className="text-blue-700" />, label: "Archivage comptable", value: "10 ans" },
          ].map((s, i) => (
            <div key={i} className="flex items-center gap-3 bg-blue-50 rounded-xl p-4">
              <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center shadow-sm">{s.icon}</div>
              <div>
                <p className="text-[11px] text-slate-500">{s.label}</p>
                <p className="text-[14px] font-semibold text-slate-800">{s.value}</p>
              </div>
            </div>
          ))}
        </div>

        <LegalSection id="applicative" title="Sécurité applicative">
          <p>Les mesures suivantes sont appliquées au niveau applicatif :</p>
          <ul className="space-y-2 pl-2">
            {[
              "Cookies sensibles HttpOnly — les tokens de session sont inaccessibles depuis JavaScript.",
              "Protection anti-falsification sur les actions sensibles.",
              "En-têtes de sécurité HTTP (CSP, X-Frame-Options, HSTS, Referrer-Policy).",
              "Gestion stricte des secrets — aucun secret en clair dans les logs ou le code versionné.",
              "Limitation des logs contenant des données personnelles (minimisation).",
              "Tests automatisés (CI) et durcissement des configurations.",
              "Objectif : un produit exploitable et fiable en production.",
            ].map((item, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <CheckCircle2 size={15} className="text-blue-600 mt-0.5 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        </LegalSection>

        <LegalSection id="auth" title="Authentification & accès">
          <LegalSubSection title="Comptes et rôles">
            <p>
              Le service applique un contrôle d'accès basé sur les rôles (RBAC) :{" "}
              <strong>owner, admin, comptable, lecteur</strong>. Chaque rôle conditionne les permissions d'accès aux
              fonctionnalités et aux données.
            </p>
            <ul className="space-y-1 pl-2 mt-2">
              <li className="flex items-start gap-2">
                <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
                Double authentification disponible selon configuration.
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
                Sessions avec durée de vie limitée et invalidation à la déconnexion.
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
                Toute action réalisée via un compte autorisé est réputée réalisée par le Client.
              </li>
            </ul>
          </LegalSubSection>
          <LegalSubSection title="Responsabilités du Client">
            <p>
              Le Client est responsable de la sécurité des accès, des mots de passe et de l'activation de la double
              authentification si disponible. Il doit notifier immédiatement l'Éditeur en cas de compromission de
              compte.
            </p>
          </LegalSubSection>
        </LegalSection>

        <LegalSection id="chiffrement" title="Chiffrement">
          <LegalTable
            headers={["Couche", "Mécanisme", "Notes"]}
            rows={[
              ["Transit", "TLS 1.2+ (TLS 1.3 préféré)", "Toutes les communications client ↔ serveur"],
              [
                "Repos (base de données)",
                "Chiffrement au niveau du fournisseur cloud (Hébergeur de l'instance)",
                "AES-256 selon configuration",
              ],
              ["Stockage objet (S3)", "Chiffrement côté serveur (SSE)", "Selon configuration du bucket"],
              ["Secrets applicatifs", "Gestion via variables d'environnement sécurisées", "Aucun secret en clair"],
            ]}
          />
        </LegalSection>

        <LegalSection id="hebergement" title="Hébergement & infrastructure">
          <LegalSubSection title="Fournisseur principal">
            <p>
              <strong>Hébergeur de l'instance</strong> — Hébergement applicatif et bases de données,{" "}
              <strong>UE/EEE selon configuration</strong>.
            </p>
            <p className="mt-2">
              Les données sont hébergées par défaut au sein de l'Union Européenne / EEE. En cas de transfert hors UE/EEE
              (ex. certains sous-traitants), des garanties appropriées sont mises en place (clauses contractuelles types
              — SCC).
            </p>
          </LegalSubSection>
          <LegalSubSection title="Monitoring & logs">
            <p>
              Monitoring applicatif configurable, journalisation des accès et des événements de sécurité, gestion des
              incidents selon la criticité. Objectifs RPO/RTO définis au contrat (offre Volume).
            </p>
          </LegalSubSection>
        </LegalSection>

        <LegalSection id="sauvegardes" title="Sauvegardes & RPO/RTO">
          <p>
            Des procédures de sauvegarde automatisées (via scripts) sont mises en place. Les paramètres précis
            (fréquence, rétention, objectifs RPO/RTO) dépendent de la configuration et sont définis au contrat le cas
            échéant.
          </p>
          <LegalTable
            headers={["Élément", "Valeur indicative", "Précision"]}
            rows={[
              ["Sauvegardes BD", "Quotidiennes (configurable)", "Dépend de la configuration"],
              ["Rétention sauvegardes", "Selon contrat", "Paramétrable"],
              ["RPO (perte max données)", "Sur demande / selon contrat", "Offre Entreprise"],
              ["RTO (délai remise en ligne)", "Sur demande / selon contrat", "Offre Entreprise"],
            ]}
          />
          <LegalCallout type="info">
            Pour des SLA et engagements RPO/RTO contractuels, contactez-nous pour une offre Volume.
          </LegalCallout>
        </LegalSection>

        <LegalSection id="sous-traitants" title="Sous-traitants (Annexe 3 DPA)">
          <p>
            Liste des sous-traitants ultérieurs. La liste peut évoluer ; notification par email en cas de changement
            substantiel.
          </p>
          <LegalTable headers={["Nom", "Finalité", "Localisation", "Garanties"]} rows={subprocessors} />
          <p className="text-[12px] text-slate-400 mt-2">
            Mise à jour : 2026-01-21. Le Client peut s'opposer à l'ajout d'un sous-traitant pour motif légitime dans un
            délai raisonnable.
          </p>
        </LegalSection>

        <LegalSection id="rgpd" title="RGPD & DPA">
          <p>
            Le traitement des données personnelles est encadré par un{" "}
            <a href="/legal/dpa" className="text-blue-700 underline underline-offset-2">
              accord de traitement des données (DPA)
            </a>{" "}
            conforme à l'article 28 du RGPD.
          </p>
          <ul className="space-y-1.5 pl-2 mt-3">
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Rôles clairement définis : Client = Responsable du traitement, Éditeur = Sous-traitant.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Traitement uniquement sur instructions documentées du Client.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Droit à l'oubli, export et portabilité disponibles.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
              Contact RGPD / DPO : communiqué sur demande.
            </li>
          </ul>
          <div className="mt-4 flex gap-3">
            <a
              href="/legal/dpa"
              className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
            >
              Voir le DPA <ExternalLink size={12} />
            </a>
            <a
              href="/legal/privacy"
              className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
            >
              Politique de confidentialité <ExternalLink size={12} />
            </a>
          </div>
        </LegalSection>

        <LegalSection id="archivage" title="Archivage & réversibilité">
          <LegalTable
            headers={["Type", "Durée", "Notes"]}
            rows={[
              ["Conservation fiscale (factures)", "6 ans", "Obligation légale"],
              ["Conservation comptable", "10 ans", "Obligation légale"],
              ["Archivage renforcé configurable", "Selon configuration", "Immutabilité Object Lock si activé"],
              ["Logs techniques", "Limités dans le temps", "Données personnelles masquées"],
            ]}
          />
          <p className="mt-3">
            Le Client peut exporter ses données (Factur‑X/PDF/CSV) à tout moment via l'interface. Une restitution
            supplémentaire peut être fournie sur demande dans un délai raisonnable (ex. 30 jours) après résiliation.
          </p>
          <LegalCallout type="warning">
            La conformité complète de l'archivage dépend de votre configuration (rétention, sauvegardes, procédures) et
            des exigences applicables à votre situation.
          </LegalCallout>
        </LegalSection>

        <LegalSection id="incidents" title="Gestion des incidents">
          <p>
            En cas de violation de données personnelles, l'Éditeur notifie le Client sans délai indu après la
            découverte. La notification comprend la nature de l'incident, les données concernées, les impacts estimés et
            les mesures correctives.
          </p>
          <p>
            Le Client peut auditer l'Éditeur dans des conditions raisonnables (préavis, périmètre limité, respect de la
            confidentialité). Les coûts excessifs ou répétés peuvent être à la charge du Client.
          </p>
        </LegalSection>

        <LegalSection id="contacts" title="Sources & contacts">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="bg-slate-50 rounded-xl p-4">
              <p className="text-[12px] uppercase tracking-widest text-slate-400 mb-2">Contact sécurité / RGPD</p>
              <p className="text-[14px] text-slate-700">Contact RGPD : communiqué sur demande</p>
              <p className="text-[13px] text-slate-500 mt-1">Objet : demandes RGPD, exercice des droits, incidents.</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-4">
              <p className="text-[12px] uppercase tracking-widest text-slate-400 mb-2">Documents associés</p>
              <div className="flex flex-col gap-1.5 mt-1">
                <a href="/legal/dpa" className="text-[13px] text-blue-700 underline underline-offset-2">
                  → Voir le DPA (accord de traitement)
                </a>
                <a href="/legal/terms" className="text-[13px] text-blue-700 underline underline-offset-2">
                  → Voir les CGU/CGV
                </a>
                <a href="/legal/privacy" className="text-[13px] text-blue-700 underline underline-offset-2">
                  → Politique de confidentialité
                </a>
              </div>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-slate-100">
            <p className="text-[12px] uppercase tracking-widest text-slate-400 mb-3">Sources officielles</p>
            <div className="flex flex-col gap-2">
              {[
                {
                  label: "Spécifications externes B2B (DGFiP)",
                  href: "https://www.impots.gouv.fr/specifications-externes-b2b",
                },
                {
                  label: "Liste officielle des plateformes agréées (PA, ex‑PDP)",
                  href: "https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees",
                },
                {
                  label: "Calendrier officiel",
                  href: "https://www.economie.gouv.fr/tout-savoir-sur-la-facturation-electronique-pour-les-entreprises",
                },
              ].map((s) => (
                <a
                  key={s.href}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
                >
                  {s.label} <ExternalLink size={11} />
                </a>
              ))}
            </div>
          </div>
        </LegalSection>

        <div className="mt-10 pt-6 border-t border-slate-100 text-[12px] text-slate-400">
          Ce document ne constitue pas un conseil juridique ou fiscal. La conformité dépend de votre situation et des
          textes applicables.
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}
