"use client";
import { motion } from "motion/react";
import {
  Shield,
  Lock,
  Server,
  Database,
  FileText,
  BadgeCheck,
  CheckCircle2,
  XCircle,
  ExternalLink,
  ArrowRight,
} from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import { AnimatedSection, AnimatedStagger, AnimatedStaggerItem } from "../components/landing/AnimatedSection";
import { LegalCallout, LegalTable } from "../components/landing/LegalPageShell";
import { TrustIllustration } from "../components/landing/Illustrations";
import { FALLBACK_LEGAL_VARIABLES, type LegalPageProps } from "./legalVariablesFallback";

const trustPillars = [
  {
    icon: <Shield size={24} className="text-blue-700" />,
    bg: "bg-blue-50",
    title: "Sécurité applicative",
    desc: "Cookies sensibles HttpOnly, protection anti-falsification, en-têtes de sécurité, secrets, minimisation des logs. Objectif : un produit exploitable et fiable en production.",
    link: "/security",
    linkLabel: "Voir la page sécurité",
  },
  {
    icon: <Lock size={24} className="text-sky-700" />,
    bg: "bg-sky-50",
    title: "Auth & chiffrement",
    desc: "Double authentification disponible, rôles d’accès, TLS en transit et chiffrement au repos selon configuration.",
    link: "/security#auth",
    linkLabel: "Détail auth",
  },
  {
    icon: <Server size={24} className="text-emerald-700" />,
    bg: "bg-emerald-50",
    title: "Hébergement UE/EEE selon l'instance",
    desc: "Localisation, monitoring, logs et sauvegardes dépendent de l’instance et de sa configuration d’exploitation. Les engagements applicables sont ceux du contrat.",
    link: "/security#hebergement",
    linkLabel: "Infrastructure",
  },
  {
    icon: <BadgeCheck size={24} className="text-amber-700" />,
    bg: "bg-amber-50",
    title: "RGPD & DPA",
    desc: "DPA disponible pour encadrer l'article 28 RGPD. Rôles, sous-traitants, mesures techniques, droit à l'oubli dans les limites de conservation légale.",
    link: "/legal/dpa",
    linkLabel: "Voir le DPA",
  },
  {
    icon: <Database size={24} className="text-rose-700" />,
    bg: "bg-rose-50",
    title: "Archivage & réversibilité",
    desc: "Exports PDF/CSV et artefacts Factur‑X lorsqu’ils existent. Rétention et archivage renforcé dépendent du contrat et de la configuration ; Object Lock ne s’applique que s’il est activé et vérifié.",
    link: "/security#archivage",
    linkLabel: "Politique archivage",
  },
  {
    icon: <FileText size={24} className="text-slate-600" />,
    bg: "bg-slate-100",
    title: "Documents légaux",
    desc: "CGV/CGU, DPA, Politique de confidentialité, Cookies, Mentions légales. Disponibles et versionnés selon la configuration publiée.",
    link: "/legal/terms",
    linkLabel: "Voir les documents",
  },
];

const doWeItems = [
  "Facturation B2B PDF en Starter ; exports Factur‑X/CII/UBL avec Pro selon artefact et configuration",
  "Génération Factur‑X (PDF + XML) avec contrôles de cohérence en Pro",
  "Pré-validation avant émission (XSD/Schematron si configuré)",
  "Contrôle des 4 nouvelles données prévues par la réforme (SIREN, livraison, nature, TVA sur les débits)",
  "Exports et traces techniques (journaux, CSV, journal des ventes — expert)",
  "Préparation des connecteurs PA avec Pro ; échanges selon contrat, mandat et statut opérationnel",
  "Hébergement UE/EEE selon l'instance · RGPD · DPA disponible",
];

const dontWeItems = [
  "Nous ne sommes pas une plateforme agréée (PA, ex‑PDP) immatriculée",
  "Nous ne gérons pas l'immatriculation de plateforme agréée",
  "Nous ne transmettons pas sans PA choisie par l'entreprise",
  "Nous ne fournissons pas de conseil fiscal/juridique",
  "Nous ne garantissons pas la conformité légale complète (dépend de votre situation)",
];

const legalDocs = [
  {
    label: "Page sécurité",
    desc: "Auth, chiffrement et options d’exploitation selon configuration et contrat",
    href: "/security",
  },
  { label: "DPA", desc: "Accord de traitement RGPD — art. 28", href: "/legal/dpa" },
  { label: "CGV/CGU", desc: "Conditions générales d'utilisation et de vente", href: "/legal/terms" },
  { label: "Confidentialité", desc: "Politique de confidentialité", href: "/legal/privacy" },
  { label: "Cookies", desc: "Politique de gestion des cookies", href: "/legal/cookies" },
  { label: "Mentions légales", desc: "Éditeur, hébergeur, directeur de publication", href: "/legal/mentions" },
];

export function ConfiancePage({ legalVariables = FALLBACK_LEGAL_VARIABLES }: LegalPageProps) {
  const supportEmail = legalVariables.company.supportEmail;
  const rgpdEmail = legalVariables.rgpdContact.email;
  const subprocessorRows = legalVariables.subprocessors.map((item) => [
    item.name,
    item.purpose,
    item.location || "Selon configuration",
    item.safeguards || (item.optional ? "Selon activation et contrat applicable" : "DPA / contrat"),
  ]);

  return (
    <LegalLayout>
      <div className="max-w-[1120px] mx-auto px-6 pb-24">
        {/* Header */}
        <div
          className="relative rounded-3xl overflow-hidden p-10 md:p-16 mt-4 mb-16"
          style={{ background: "linear-gradient(145deg, #0f172a 0%, #1e3a8a 55%, #1d4ed8 100%)" }}
        >
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)",
              backgroundSize: "50px 50px",
              opacity: 0.03,
            }}
          />
          <div className="relative z-10 grid lg:grid-cols-2 gap-10 items-center">
            <div>
              <span className="inline-block text-[11px] uppercase tracking-widest text-blue-300 mb-4">
                Centre de confiance
              </span>
              <h1 className="text-[32px] md:text-[44px] font-bold text-white leading-tight tracking-tight mb-4">
                Sécurité, conformité & transparence
              </h1>
              <p className="text-[16px] text-blue-200 max-w-xl leading-relaxed">
                Une documentation de préparation à l’exploitation, partageable avec vos équipes. Nous décrivons nos
                choix d’architecture, le cadre RGPD proposé et notre positionnement face à la réforme 2026–2027, sans
                revendiquer de certification juridique ou de sécurité.
              </p>
            </div>
            <div
              className="rounded-2xl overflow-hidden aspect-[16/9] hidden lg:block"
              style={{ border: "1px solid rgba(255,255,255,0.06)", opacity: 0.9 }}
            >
              <TrustIllustration />
            </div>
          </div>
        </div>

        {/* Positionnement clair */}
        <AnimatedSection className="mb-16">
          <h2 className="text-[22px] font-bold text-slate-900 mb-6">Positionnement & périmètre</h2>
          <LegalCallout type="important">
            <strong>PixFacture</strong> est un logiciel de facturation B2B : devis et factures PDF en Starter ; achats,
            paiements et exports structurés avec Pro selon configuration. Seqino et Chorus ne deviennent utilisables
            qu'après activation opérationnelle. Nous ne sommes pas une plateforme agréée (PA, ex‑PDP).
          </LegalCallout>
          <div className="grid sm:grid-cols-2 gap-5 mt-6">
            <div className="border border-emerald-200 rounded-2xl p-5 bg-emerald-50">
              <p className="text-[12px] uppercase tracking-widest text-emerald-700 mb-3">Ce que nous faisons</p>
              <ul className="space-y-2">
                {doWeItems.map((item, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[13px] text-emerald-800">
                    <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="border border-rose-200 rounded-2xl p-5 bg-rose-50">
              <p className="text-[12px] uppercase tracking-widest text-rose-700 mb-3">Ce que nous ne faisons pas</p>
              <ul className="space-y-2">
                {dontWeItems.map((item, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[13px] text-rose-800">
                    <XCircle size={14} className="mt-0.5 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </AnimatedSection>

        {/* 6 piliers de confiance */}
        <AnimatedSection className="mb-16">
          <span className="text-[12px] uppercase tracking-widest text-blue-700 mb-4 block">Piliers de confiance</span>
          <h2 className="text-[28px] font-bold text-slate-900 mb-8">Ce qui protège vos données et votre activité</h2>
          <AnimatedStagger className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {trustPillars.map((p, i) => (
              <AnimatedStaggerItem key={i}>
                <motion.div
                  className="bg-white border rounded-2xl p-5 flex flex-col gap-3 h-full"
                  style={{ borderColor: "rgba(15,23,42,0.07)" }}
                  whileHover={{ y: -4, boxShadow: "0 16px 40px rgba(15,23,42,0.08)", borderColor: "#dbeafe" }}
                  transition={{ type: "spring", stiffness: 280, damping: 22 }}
                >
                  <div className={`w-12 h-12 rounded-xl ${p.bg} flex items-center justify-center`}>{p.icon}</div>
                  <h3 className="text-[15px] font-semibold text-slate-900">{p.title}</h3>
                  <p className="text-[13px] text-slate-500 leading-[1.65] flex-1">{p.desc}</p>
                  <a
                    href={p.link}
                    className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2 self-start"
                  >
                    {p.linkLabel} <ArrowRight size={12} />
                  </a>
                </motion.div>
              </AnimatedStaggerItem>
            ))}
          </AnimatedStagger>
        </AnimatedSection>

        {/* Sous-traitants */}
        <AnimatedSection className="mb-16">
          <h2 className="text-[22px] font-bold text-slate-900 mb-2">Sous-traitants (Annexe 3 DPA)</h2>
          <p className="text-[14px] text-slate-500 mb-6">
            Liste complète dans la{" "}
            <a href="/legal/dpa" className="text-blue-700 underline underline-offset-2">
              DPA
            </a>
            . Notification en cas de changement substantiel.
          </p>
          <LegalTable headers={["Nom", "Finalité", "Localisation", "Garanties"]} rows={subprocessorRows} />
        </AnimatedSection>

        {/* Documents légaux */}
        <AnimatedSection className="mb-16">
          <span className="text-[12px] uppercase tracking-widest text-blue-700 mb-4 block">Documents & ressources</span>
          <h2 className="text-[22px] font-bold text-slate-900 mb-6">Documents disponibles</h2>
          <AnimatedStagger className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {legalDocs.map((doc, i) => (
              <AnimatedStaggerItem key={i}>
                <a
                  href={doc.href}
                  className="flex flex-col gap-1.5 p-4 rounded-xl border border-slate-200 bg-white hover:border-blue-200 hover:shadow-md transition-all group"
                >
                  <p className="text-[14px] font-semibold text-slate-800 group-hover:text-blue-700 transition-colors flex items-center gap-1.5">
                    {doc.label} <ExternalLink size={12} className="text-slate-400 group-hover:text-blue-500" />
                  </p>
                  <p className="text-[12px] text-slate-500">{doc.desc}</p>
                </a>
              </AnimatedStaggerItem>
            ))}
          </AnimatedStagger>
        </AnimatedSection>

        <AnimatedSection className="mb-16">
          <div className="rounded-2xl border border-blue-100 bg-blue-50 p-6">
            <p className="text-[12px] uppercase tracking-widest text-blue-700 mb-3">Support public</p>
            <div className="grid sm:grid-cols-2 gap-4 text-[13px] text-slate-700">
              <div>
                <p>
                  <strong className="text-slate-900">Support :</strong>{" "}
                  <a href={`mailto:${supportEmail}`} className="text-blue-700 underline underline-offset-2">
                    {supportEmail}
                  </a>
                </p>
              </div>
              <div>
                <p>
                  <strong className="text-slate-900">RGPD :</strong>{" "}
                  {rgpdEmail ? (
                    <a href={`mailto:${rgpdEmail}`} className="text-blue-700 underline underline-offset-2">
                      {rgpdEmail}
                    </a>
                  ) : (
                    "via le support public"
                  )}
                </p>
                <p className="mt-1">Utilisable pour les demandes produit, incidents et exercice des droits.</p>
              </div>
            </div>
          </div>
        </AnimatedSection>

        {/* Sources officielles */}
        <AnimatedSection className="mb-10">
          <div className="bg-slate-50 rounded-2xl p-6">
            <p className="text-[12px] uppercase tracking-widest text-slate-600 mb-4">
              Sources officielles — Réforme 2026–2027
            </p>
            <p className="text-[13px] text-slate-500 mb-4">
              Les informations sur la réforme sont fournies à titre informatif et peuvent évoluer. Références :
            </p>
            <div className="flex flex-col gap-2">
              {[
                {
                  label: "Spécifications externes B2B (DGFiP)",
                  href: "https://www.impots.gouv.fr/specifications-externes-b2b",
                },
                {
                  label: "Calendrier officiel",
                  href: "https://www.impots.gouv.fr/professionnel/je-passe-la-facturation-electronique",
                },
                {
                  label: "Liste officielle des plateformes agréées (PA, ex‑PDP)",
                  href: "https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees",
                },
                {
                  label: "Facturation électronique et plateformes agréées",
                  href: "https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees",
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
            <p className="text-[11px] text-slate-600 mt-4">Le service ne constitue pas un conseil fiscal/juridique.</p>
          </div>
        </AnimatedSection>
      </div>
    </LegalLayout>
  );
}
