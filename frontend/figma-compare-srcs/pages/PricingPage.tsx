import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Check,
  Minus,
  Sparkles,
  ArrowRight,
  ExternalLink,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Zap,
} from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import { Link } from "react-router";

const plans = [
  {
    name: "Starter",
    tagline: "Facturation + export",
    monthly: "29",
    annual: "24",
    desc: "Idéal pour démarrer sans friction.",
    cta: "Choisir Starter",
    ctaHref: "/app/register",
    featured: false,
    features: [
      { text: "Factures PDF professionnelles", included: true },
      { text: "Clients / articles / TVA", included: true },
      { text: "Export CSV / journal", included: true },
      { text: "Contrôles de cohérence", included: true },
      { text: "1 utilisateur", included: true },
      { text: "Factur‑X (PDF + XML)", included: false },
      { text: "Multi‑utilisateurs + rôles", included: false },
      { text: "Connecteur PA (si configuré)", included: false },
      { text: "SSO (SAML/OIDC) + SCIM", included: false },
    ],
  },
  {
    name: "Pro",
    tagline: "Factur‑X + connecteur PA",
    monthly: "59",
    annual: "49",
    desc: "Le bon équilibre conformité / volume.",
    cta: "Choisir Pro",
    ctaHref: "/app/register",
    featured: true,
    badge: "Recommandé",
    features: [
      { text: "Tout Starter inclus", included: true },
      { text: "Factur‑X (PDF + XML)", included: true },
      { text: "CII (format structuré) + UBL (option)", included: true },
      { text: "Jetons de transmission selon usage", included: true },
      { text: "Multi‑utilisateurs + rôles", included: true },
      { text: "Rapport de contrôles par facture", included: true },
      { text: "Connecteur PA (activation gérée)", included: true },
      { text: "API (beta)", included: true },
      { text: "SSO (SAML/OIDC) + SCIM", included: false },
    ],
  },
  {
    name: "Volume",
    tagline: "Intégrations & volumes",
    monthly: null,
    annual: null,
    desc: "Périmètre, volume, intégrations sur mesure.",
    cta: "Demander un devis",
    ctaHref: "/contact",
    featured: false,
    features: [
      { text: "Tout Pro inclus", included: true },
      { text: "Intégrations ERP / SI (sur devis)", included: true },
      { text: "Audit export & journaux", included: true },
      { text: "SSO (SAML/OIDC) + SCIM (bientôt)", included: true },
      { text: "Accompagnement intégration ERP", included: true },
      { text: "E‑reporting (via PA / export)", included: true },
      { text: "Archivage renforcé configurable (Object Lock si activé)", included: true },
      { text: "SLA dédié + support prioritaire", included: true },
    ],
  },
];

const comparisonRows = [
  {
    label: "Plateforme agréée incluse ?",
    essentials: "Non (contrat PA à prévoir)",
    standard: "Non (contrat PA à prévoir)",
    enterprise: "Option (sur devis)",
  },
  { label: "Factures PDF", essentials: "✓", standard: "✓", enterprise: "✓" },
  { label: "Factur‑X (PDF + XML)", essentials: "—", standard: "✓", enterprise: "✓" },
  { label: "CII + UBL (option)", essentials: "—", standard: "✓", enterprise: "✓" },
  { label: "Multi‑utilisateurs + rôles", essentials: "1 utilisateur", standard: "✓", enterprise: "✓" },
  { label: "Connecteur PA (si configuré)", essentials: "—", standard: "✓ (activation gérée)", enterprise: "✓" },
  { label: "Jetons de transmission", essentials: "—", standard: "Packs selon usage", enterprise: "Sur devis" },
  { label: "Rapport contrôles par facture", essentials: "—", standard: "✓", enterprise: "✓" },
  { label: "API (beta)", essentials: "—", standard: "✓ (beta)", enterprise: "✓" },
  { label: "SSO / SCIM", essentials: "—", standard: "Bientôt", enterprise: "✓ (sur devis)" },
  { label: "Audit export", essentials: "—", standard: "—", enterprise: "✓ (sur devis)" },
  { label: "E‑reporting", essentials: "—", standard: "En préparation", enterprise: "En préparation" },
  { label: "Archivage renforcé configurable", essentials: "—", standard: "—", enterprise: "Roadmap" },
  {
    label: "Chorus Pro (B2G)",
    essentials: "Si configuré",
    standard: "Connecteur partenaire",
    enterprise: "✓ (si dispo)",
  },
];

const complianceItems = [
  { label: "2027 : en cours / suivi", value: "Factur‑X / EN16931 (CII) : génération + validation", icon: "✓" },
  { label: "Connecteur PA", value: "Plateforme agréée activable selon plan", icon: "✓" },
  { label: "E‑reporting", value: "En préparation via PA / export selon périmètre", icon: "⟳" },
  { label: "Chorus Pro (B2G)", value: "Si configuré (PISTE + identifiants)", icon: "✓" },
  { label: "4 mentions obligatoires", value: "SIREN, livraison, nature, TVA sur débits", icon: "✓" },
  { label: "Archivage", value: "Conservation à paramétrer selon vos obligations", icon: "✓" },
];

const reformeCalendrier = [
  { date: "2026", label: "Réception obligatoire pour toutes les entreprises" },
  { date: "2026", label: "Émission : GE/ETI" },
  { date: "2027", label: "Émission : PME + micro-entreprises" },
  { date: "2026–2027", label: "E‑reporting : même calendrier (via PA / export)" },
];

export function PricingPage() {
  const [annual, setAnnual] = useState(false);
  const [showComparison, setShowComparison] = useState(true);

  return (
    <LegalLayout>
      <div className="max-w-[1200px] mx-auto px-6 pb-24">
        {/* Hero header */}
        <div className="py-16 mb-8">
          <div className="max-w-[900px] mx-auto text-center">
            <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 mb-4">
              Tarifs
            </span>
            <h1 className="text-[38px] md:text-[52px] font-bold text-slate-900 leading-[1.1] tracking-tight mb-5">
              Plans adaptés à votre volume
            </h1>
            <p className="text-[17px] text-slate-500 max-w-xl mx-auto leading-relaxed mb-8">
              Évoluez selon vos besoins. Démarrez en mode export, activez le mode connecté selon votre contrat et votre
              plateforme agréée.
            </p>

            {/* Toggle */}
            <div
              className="inline-flex items-center rounded-2xl p-1.5 gap-1 mb-6"
              style={{ background: "#f1f5f9", border: "1px solid #e2e8f0" }}
            >
              <button
                onClick={() => setAnnual(false)}
                className={`px-5 py-2 rounded-xl text-[13px] font-medium transition-all cursor-pointer border-none ${
                  !annual ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 bg-transparent"
                }`}
              >
                Mensuel
              </button>
              <button
                onClick={() => setAnnual(true)}
                className={`px-5 py-2 rounded-xl text-[13px] font-medium transition-all cursor-pointer border-none flex items-center gap-2 ${
                  annual ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 bg-transparent"
                }`}
              >
                Annuel
                <AnimatePresence>
                  {annual && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.7 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.7 }}
                      className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                      style={{ background: "linear-gradient(135deg, #059669, #10b981)", color: "white" }}
                    >
                      −2 mois
                    </motion.span>
                  )}
                </AnimatePresence>
                {!annual && (
                  <span className="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-medium">
                    économisez
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Plans grid */}
        <div className="grid md:grid-cols-3 gap-6 mb-12">
          {plans.map((plan) => (
            <motion.div
              key={plan.name}
              className={`relative rounded-3xl p-8 flex flex-col gap-6 h-full ${plan.featured ? "" : "bg-white"}`}
              style={
                plan.featured
                  ? {
                      background: "linear-gradient(160deg, #0f1e36 0%, #1e3a8a 50%, #1d4ed8 100%)",
                      boxShadow: "0 32px 80px rgba(29,78,216,0.3)",
                    }
                  : { border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }
              }
              whileHover={{
                y: plan.featured ? -8 : -5,
                boxShadow: plan.featured ? "0 48px 100px rgba(29,78,216,0.35)" : "0 24px 64px rgba(0,0,0,0.1)",
              }}
              transition={{ type: "spring", stiffness: 280, damping: 20 }}
            >
              {plan.featured && plan.badge && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                  <span
                    className="inline-flex items-center gap-1.5 text-[12px] font-bold px-4 py-1.5 rounded-full whitespace-nowrap"
                    style={{
                      background: "linear-gradient(135deg, #f59e0b, #fbbf24)",
                      color: "#78350f",
                      boxShadow: "0 4px 12px rgba(245,158,11,0.4)",
                    }}
                  >
                    <Sparkles size={12} /> {plan.badge}
                  </span>
                </div>
              )}

              <div className="flex flex-col gap-4">
                <div className="space-y-3">
                  <p
                    className={`text-[11px] font-semibold uppercase tracking-[0.1em] ${plan.featured ? "text-blue-300" : "text-slate-400"}`}
                  >
                    {plan.tagline}
                  </p>
                  <h3
                    className={`text-[22px] font-bold leading-tight tracking-[-0.02em] ${plan.featured ? "text-white" : "text-slate-900"}`}
                  >
                    {plan.name}
                  </h3>
                </div>
                <div className="space-y-3">
                  <div className="flex items-end gap-1.5">
                    <AnimatePresence mode="wait">
                      <motion.span
                        key={annual ? "a" : "m"}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.2 }}
                        className={`text-[44px] font-bold tracking-tight leading-none ${plan.featured ? "text-white" : "text-slate-900"}`}
                      >
                        {plan.monthly ? `${annual ? plan.annual : plan.monthly}€` : "Sur devis"}
                      </motion.span>
                    </AnimatePresence>
                    {plan.monthly && (
                      <span className={`text-[14px] mb-1.5 ${plan.featured ? "text-blue-300" : "text-slate-400"}`}>
                        /mois
                      </span>
                    )}
                  </div>
                  <p className={`text-[13px] leading-[1.7] ${plan.featured ? "text-blue-200" : "text-slate-400"}`}>
                    {plan.desc}
                  </p>
                </div>
              </div>

              {plan.monthly && (
                <ul className="flex flex-col gap-2.5 flex-1">
                  {plan.features.map((f, j) => (
                    <li key={j} className="flex items-center gap-2.5 text-[13px]">
                      {f.included ? (
                        <div
                          className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${plan.featured ? "bg-blue-500/30" : "bg-blue-50"}`}
                        >
                          <Check size={11} className={plan.featured ? "text-blue-200" : "text-blue-600"} />
                        </div>
                      ) : (
                        <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 bg-slate-100">
                          <Minus size={10} className="text-slate-300" />
                        </div>
                      )}
                      <span
                        className={
                          f.included
                            ? plan.featured
                              ? "text-blue-100"
                              : "text-slate-700"
                            : plan.featured
                              ? "text-blue-800/50"
                              : "text-slate-300"
                        }
                      >
                        {f.text}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {!plan.monthly && <div className="flex-1" />}

              <motion.a
                href={plan.ctaHref}
                className={`w-full py-3.5 rounded-2xl text-[14px] font-semibold cursor-pointer border-none text-center block ${
                  plan.featured ? "bg-white text-blue-700 hover:bg-blue-50" : "text-white hover:opacity-90"
                }`}
                style={!plan.featured ? { background: "linear-gradient(135deg, #1d4ed8, #3b82f6)" } : {}}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
              >
                {plan.cta}
              </motion.a>
            </motion.div>
          ))}
        </div>

        {/* Compliance coverage */}
        <div className="rounded-2xl p-7 bg-white mb-10" style={{ border: "1px solid #e2e8f0" }}>
          <div className="flex items-center gap-3 mb-5">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #1d4ed8, #3b82f6)" }}
            >
              <Zap size={14} className="text-white" />
            </div>
            <span className="text-[13px] font-bold text-slate-900 uppercase tracking-wider">
              Couverture conformité 2026–2027
            </span>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 mb-4">
            {complianceItems.map((item, i) => (
              <div key={i} className="flex items-start gap-3">
                <span
                  className={`text-[14px] font-bold shrink-0 ${item.icon === "✓" ? "text-emerald-600" : "text-amber-500"}`}
                >
                  {item.icon}
                </span>
                <div>
                  <span className="text-[12px] font-bold text-slate-700">{item.label} — </span>
                  <span className="text-[12px] text-slate-500">{item.value}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-400 pt-4" style={{ borderTop: "1px solid #f1f5f9" }}>
            PA = plateforme agréée (ex‑PDP). La transmission s'effectue via une PA sous contrat/mandat. Nous ne sommes
            pas une PA immatriculée.
          </p>
        </div>

        {/* Réforme 2026–2027 */}
        <div className="mb-10 rounded-2xl p-7" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400 mb-2 block">
            Réforme
          </span>
          <h2 className="text-[22px] font-bold text-slate-900 mb-6">2026–2027 : calendrier & mentions</h2>
          <div className="grid md:grid-cols-2 gap-8">
            <div>
              <p className="text-[13px] font-bold text-slate-700 mb-4">Calendrier officiel</p>
              <div className="flex flex-col gap-3">
                {reformeCalendrier.map((c, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span
                      className="text-[11px] font-bold px-2.5 py-1 rounded-xl shrink-0 mt-0.5"
                      style={{ background: "rgba(29,78,216,0.08)", color: "#1d4ed8" }}
                    >
                      {c.date}
                    </span>
                    <p className="text-[13px] text-slate-600">{c.label}</p>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[13px] font-bold text-slate-700 mb-4">4 mentions obligatoires</p>
              <ul className="flex flex-col gap-2.5">
                {[
                  "SIREN du client",
                  "Adresse de livraison (si différente)",
                  "Nature de l'opération : biens / services / mixte",
                  "TVA sur les débits (mention si applicable)",
                ].map((m, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[13px] text-slate-600">
                    <div className="w-5 h-5 rounded-full bg-emerald-50 flex items-center justify-center shrink-0 mt-0.5">
                      <Check size={11} className="text-emerald-600" />
                    </div>
                    {m}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-5 pt-4 flex gap-4 flex-wrap" style={{ borderTop: "1px solid #e2e8f0" }}>
            {[
              {
                label: "Calendrier officiel",
                href: "https://www.economie.gouv.fr/tout-savoir-sur-la-facturation-electronique-pour-les-entreprises",
              },
              { label: "Spécifications B2B (DGFiP)", href: "https://www.impots.gouv.fr/specifications-externes-b2b" },
              {
                label: "Liste plateformes agréées",
                href: "https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees",
              },
            ].map((l) => (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-blue-600 hover:text-blue-700"
              >
                {l.label} <ExternalLink size={10} />
              </a>
            ))}
          </div>
        </div>

        {/* Comparison table */}
        <div className="mb-12">
          <button
            onClick={() => setShowComparison(!showComparison)}
            className="flex items-center gap-2.5 text-[14px] font-semibold text-blue-600 cursor-pointer bg-transparent border-none mb-4 hover:text-blue-700 transition-colors"
          >
            {showComparison ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            {showComparison ? "Masquer" : "Afficher"} le tableau comparatif complet
          </button>
          <AnimatePresence>
            {showComparison && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                <div className="hidden overflow-x-auto rounded-2xl sm:block" style={{ border: "1px solid #e2e8f0" }}>
                  <table className="w-full text-[13px] border-collapse">
                    <thead>
                      <tr style={{ background: "#f8fafc" }}>
                        <th className="text-left p-4 text-slate-600 font-semibold border-b border-slate-200">
                          Fonctionnalité
                        </th>
                        <th className="text-center p-4 border-b border-l border-slate-200 text-slate-600 font-semibold">
                          Starter
                        </th>
                        <th
                          className="text-center p-4 border-b border-l text-blue-700 font-bold"
                          style={{ background: "rgba(29,78,216,0.04)", borderColor: "rgba(29,78,216,0.15)" }}
                        >
                          Pro
                        </th>
                        <th className="text-center p-4 border-b border-l border-slate-200 text-slate-600 font-semibold">
                          Entreprise
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparisonRows.map((row, i) => (
                        <tr key={i} style={{ background: i % 2 === 0 ? "white" : "#f8fafc" }}>
                          <td className="p-4 border-b border-slate-100 text-slate-700 font-medium">{row.label}</td>
                          <td className="p-4 border-b border-l border-slate-100 text-center text-slate-500">
                            {row.essentials}
                          </td>
                          <td
                            className="p-4 border-b border-l text-center font-medium text-blue-700"
                            style={{ background: "rgba(29,78,216,0.03)", borderColor: "rgba(29,78,216,0.1)" }}
                          >
                            {row.standard}
                          </td>
                          <td className="p-4 border-b border-l border-slate-100 text-center text-slate-600">
                            {row.enterprise}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid gap-3 sm:hidden">
                  {comparisonRows.map((row, i) => (
                    <article key={i} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                      <h3 className="m-0 border-b border-slate-200 bg-slate-50 px-4 py-3 text-[14px] font-semibold text-slate-900">
                        {row.label}
                      </h3>
                      {[
                        ["Starter", row.essentials],
                        ["Pro", row.standard],
                        ["Volume", row.enterprise],
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0"
                        >
                          <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-slate-400">
                            {label}
                          </span>
                          <span className="min-w-0 break-words text-[13px] text-slate-700">{value}</span>
                        </div>
                      ))}
                    </article>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div
          className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-6"
          style={{ borderTop: "1px solid #e2e8f0" }}
        >
          <div className="flex items-start gap-2 text-[12px] text-slate-400">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span>
              Déjà client ?{" "}
              <a href="/app/login" className="text-blue-600 font-medium hover:underline">
                Se connecter
              </a>{" "}
              ·{" "}
              <Link to="/features" className="text-blue-600 font-medium hover:underline">
                Voir toutes les fonctionnalités
              </Link>
            </span>
          </div>
          <a
            href="/contact"
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-blue-600 hover:text-blue-700"
          >
            Cas particulier ? Parler à un expert <ArrowRight size={13} />
          </a>
        </div>
      </div>
    </LegalLayout>
  );
}
