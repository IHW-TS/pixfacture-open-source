"use client";
import { Shield, Lock, Server, Database, FileText, BadgeCheck, CheckCircle2, ExternalLink } from "lucide-react";
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

export function SecurityPage({ legalVariables = FALLBACK_LEGAL_VARIABLES }: LegalPageProps) {
  const legal = legalVariables;
  const supportEmail = legal.company.supportEmail;
  const supportHours = legal.support.hours;
  const supportTimezone = legal.support.timezone;
  const rgpdEmail = legal.rgpdContact.email;
  const securityLastUpdated = legal.company.legalLastUpdatedISO || "—";
  const subprocessorsLastUpdated =
    formatSubprocessorDate(legal.subprocessorsLastUpdated || securityLastUpdated) || securityLastUpdated;
  const subprocessors = legal.subprocessors.map((item) => [
    item.optional ? `${item.name} (optionnel)` : item.name,
    item.purpose,
    item.location || "Selon configuration",
    item.safeguards || "Contrat / DPA",
  ]);

  return (
    <LegalLayout>
      <LegalPageShell
        badge="Centre de confiance"
        title="Page sécurité"
        subtitle="Auth, chiffrement, sauvegardes, monitoring, logs et hébergement selon l’instance. Ce document décrit le cadre prévu ; les mesures d’exploitation effectives et les engagements RPO/RTO dépendent de la configuration vérifiée et du contrat."
        version="1.0"
        lastUpdated={securityLastUpdated}
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
            {
              icon: <Lock size={20} className="text-blue-700" />,
              label: "Chiffrement transit",
              value: "Selon terminaison TLS",
            },
            {
              icon: <Database size={20} className="text-blue-700" />,
              label: "Rétention / archivage",
              value: "Selon contrat et configuration",
            },
          ].map((s, i) => (
            <div key={i} className="flex items-center gap-3 bg-blue-50 rounded-xl p-4">
              <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center shadow-sm">{s.icon}</div>
              <div>
                <p className="text-[11px] text-slate-600">{s.label}</p>
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
              "En-têtes de sécurité HTTP prévus (CSP, X-Frame-Options, HSTS, Referrer-Policy), à vérifier sur le déploiement public.",
              "Secrets applicatifs fournis par configuration sécurisée ; les contrôles automatisés visent à éviter leur présence dans les logs ou le code versionné.",
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
              <strong>propriétaire, administrateur, comptable, commercial et lecteur</strong>. Chaque rôle conditionne
              les permissions d'accès aux fonctionnalités et aux données.
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
              [
                "Transit",
                "TLS 1.2+ visé (TLS 1.3 si disponible)",
                "À confirmer sur la terminaison TLS de l’instance publique",
              ],
              [
                "Repos (base de données)",
                "Chiffrement au niveau du fournisseur cloud",
                "Chiffrement au repos selon fournisseur et configuration",
              ],
              ["Stockage objet (S3)", "Chiffrement côté serveur (SSE)", "Selon configuration du bucket"],
              ["Secrets applicatifs", "Gestion via variables d'environnement sécurisées", "Aucun secret en clair"],
            ]}
          />
        </LegalSection>

        <LegalSection id="hebergement" title="Hébergement & infrastructure">
          <LegalSubSection title="Fournisseur principal">
            <p>
              Hébergement applicatif et bases de données dans l'
              <strong>UE/EEE selon la configuration de l'instance</strong>.
            </p>
            <p className="mt-2">
              La localisation effective doit être vérifiée pour chaque instance et chaque sous-traitant. En cas de
              transfert hors UE/EEE, les garanties applicables doivent être documentées dans les contrats et le DPA (par
              exemple des clauses contractuelles types lorsque requises).
            </p>
          </LegalSubSection>
          <LegalSubSection title="Monitoring & logs">
            <p>
              Monitoring applicatif configurable, journalisation des accès et des événements de sécurité, gestion des
              incidents selon la criticité. Objectifs RPO/RTO définis au contrat pour les offres sur devis.
            </p>
          </LegalSubSection>
        </LegalSection>

        <LegalSection id="sauvegardes" title="Sauvegardes & RPO/RTO">
          <p>
            Des scripts et procédures de sauvegarde sont prévus. Leur planification, leur stockage hors hôte, leur
            rétention et les tests de restauration doivent être activés et vérifiés sur l’instance concernée. Aucun
            objectif RPO/RTO n’est garanti sans engagement contractuel explicite.
          </p>
          <LegalTable
            headers={["Élément", "Valeur indicative", "Précision"]}
            rows={[
              ["Sauvegardes BD", "À planifier et vérifier", "Fréquence selon l’instance"],
              ["Rétention sauvegardes", "Selon contrat", "À configurer et contrôler"],
              ["RPO (perte max données)", "Non garanti par défaut", "Engagement contractuel requis"],
              ["RTO (délai remise en ligne)", "Non garanti par défaut", "Engagement contractuel requis"],
            ]}
          />
          <LegalCallout type="info">
            Pour des SLA et engagements RPO/RTO contractuels, contactez-nous pour une offre sur devis.
          </LegalCallout>
        </LegalSection>

        <LegalSection id="sous-traitants" title="Sous-traitants (Annexe 3 DPA)">
          <p>
            Liste des sous-traitants ultérieurs. La liste peut évoluer ; notification par email en cas de changement
            substantiel.
          </p>
          <LegalTable headers={["Nom", "Finalité", "Localisation", "Garanties"]} rows={subprocessors} />
          <p className="text-[12px] text-slate-600 mt-2">
            Mise à jour : {subprocessorsLastUpdated}. Le Client peut s'opposer à l'ajout d'un sous-traitant pour motif
            légitime dans un délai raisonnable.
          </p>
        </LegalSection>

        <LegalSection id="rgpd" title="RGPD & DPA">
          <p>
            Le traitement des données personnelles est encadré par un{" "}
            <a href="/legal/dpa" className="text-blue-700 underline underline-offset-2">
              accord de traitement des données (DPA)
            </a>{" "}
            destiné à encadrer les exigences de l'article 28 du RGPD.
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
              Droit à l'oubli, export et portabilité disponibles dans les limites des obligations légales de
              conservation.
            </li>
            {rgpdEmail && (
              <li className="flex items-start gap-2">
                <CheckCircle2 size={14} className="text-blue-600 mt-0.5 shrink-0" />
                {legal.rgpdContact.label} :{" "}
                <a href={`mailto:${rgpdEmail}`} className="text-blue-700 underline underline-offset-2">
                  {rgpdEmail}
                </a>
              </li>
            )}
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
              ["Conservation fiscale (factures)", "Durée légale applicable", "Responsabilité à cadrer au contrat"],
              ["Conservation comptable", "Durée légale applicable", "Responsabilité à cadrer au contrat"],
              ["Archivage renforcé", "Selon configuration vérifiée", "Object Lock uniquement si activé et contrôlé"],
              ["Logs techniques", "Limités dans le temps", "Données personnelles masquées"],
            ]}
          />
          <p className="mt-3">
            Le Client peut exporter ses données PDF/CSV et, lorsqu'ils existent, ses artefacts Factur‑X via l'interface.
            L'export complet de réversibilité reste disponible au propriétaire, y compris pour les données conservées de
            modules antérieurement utilisés. Une restitution supplémentaire peut être fournie sur demande dans un délai
            raisonnable (par exemple 30 jours) après résiliation.
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
              <p className="text-[12px] uppercase tracking-widest text-slate-600 mb-2">Support sécurité / RGPD</p>
              <div className="space-y-1.5 text-[13px] text-slate-600">
                <p>
                  <strong className="text-slate-800">Support :</strong>{" "}
                  <a href={`mailto:${supportEmail}`} className="text-blue-700 underline underline-offset-2">
                    {supportEmail}
                  </a>
                </p>
                {rgpdEmail && (
                  <p>
                    <strong className="text-slate-800">RGPD :</strong>{" "}
                    <a href={`mailto:${rgpdEmail}`} className="text-blue-700 underline underline-offset-2">
                      {rgpdEmail}
                    </a>
                  </p>
                )}
                {supportHours && (
                  <p>
                    <strong className="text-slate-800">Disponibilité indicative :</strong> {supportHours}
                    {supportTimezone ? ` (${supportTimezone})` : ""}
                  </p>
                )}
                <p>Objet : demandes RGPD, exercice des droits, incidents et questions de sécurité.</p>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-4">
              <p className="text-[12px] uppercase tracking-widest text-slate-600 mb-2">Documents associés</p>
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
            <p className="text-[12px] uppercase tracking-widest text-slate-600 mb-3">Sources officielles</p>
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
                  href: "https://www.impots.gouv.fr/professionnel/je-passe-la-facturation-electronique",
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

        <div className="mt-10 pt-6 border-t border-slate-100 text-[12px] text-slate-600">
          Ce document ne constitue pas un conseil juridique ou fiscal. La conformité dépend de votre situation et des
          textes applicables.
        </div>
      </LegalPageShell>
    </LegalLayout>
  );
}
