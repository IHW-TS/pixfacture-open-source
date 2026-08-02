import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  FileCheck,
  Inbox,
  Building2,
  BarChart2,
  Archive,
  ShieldCheck,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Zap,
  Users,
  TrendingUp,
  Bell,
  LineChart,
  Import,
  MessageSquare,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";
import { Link } from "react-router";
import { WorkflowIllustration } from "../components/landing/Illustrations";

const features = [
  {
    icon: <FileCheck size={22} />,
    gradient: "from-blue-600 to-indigo-600",
    title: "Facturation B2B (PDF + Factur‑X Pro)",
    desc: "Créez vos devis et factures en PDF. Les exports Factur‑X (PDF + XML) et les validations EN16931 sont disponibles avec Pro selon activation, mandat et configuration.",
    badge: "Core",
    badgeBg: "bg-blue-50 text-blue-700 border-blue-100",
    details: ["PDF par défaut", "Factur‑X Pro (PDF + XML)", "Contrôles de cohérence", "Export CSV / journal"],
  },
  {
    icon: <Inbox size={22} />,
    gradient: "from-sky-600 to-cyan-500",
    title: "Réception (Inbox) + statuts",
    desc: "Activez la réception des factures et le suivi du cycle de vie avec un mandat confirmé explicitement depuis l’app. Sans activation, vous restez en mode export.",
    badge: "Activation app",
    badgeBg: "bg-sky-50 text-sky-700 border-sky-100",
    details: [
      "Inbox factures reçues",
      "Suivi statuts cycle de vie",
      "Mandat géré automatiquement",
      "Mode export par défaut",
    ],
  },
  {
    icon: <Building2 size={22} />,
    gradient: "from-slate-500 to-slate-600",
    title: "Chorus Pro (B2G)",
    desc: "B2G via Chorus Pro (PISTE) possible selon votre configuration. Connecteur disponible selon besoin. Identifiants et paramètres requis.",
    badge: "Si configuré",
    badgeBg: "bg-slate-100 text-slate-600 border-slate-200",
    details: ["Connecteur PISTE (B2G)", "Identifiants requis", "Distinct du B2B e-invoicing", "Sur activation"],
  },
  {
    icon: <BarChart2 size={22} />,
    gradient: "from-amber-500 to-orange-500",
    title: "E‑reporting (en préparation)",
    desc: "En préparation. Mode export possible ; automatisation prévue via connecteur partenaire selon votre périmètre (B2C / international / paiements).",
    badge: "Roadmap 2026",
    badgeBg: "bg-amber-50 text-amber-700 border-amber-100",
    details: [
      "Mode export disponible",
      "Via PA partenaire (en prép.)",
      "B2C / international / paiements",
      "Même calendrier 2026–2027",
    ],
  },
  {
    icon: <Archive size={22} />,
    gradient: "from-emerald-600 to-teal-500",
    title: "Archivage & réversibilité",
    desc: "Stockage objet (S3 compatible) + politique de rétention paramétrable. Export complet (Factur‑X/PDF/CSV) pour réversibilité. Archivage renforcé configurable (immutabilité Object Lock si activé).",
    badge: "Conservation paramétrable",
    badgeBg: "bg-emerald-50 text-emerald-700 border-emerald-100",
    details: [
      "Stockage S3 compatible",
      "Rétention paramétrable",
      "Export complet réversibilité",
      "Object Lock (si activé)",
    ],
  },
  {
    icon: <ShieldCheck size={22} />,
    gradient: "from-rose-600 to-pink-600",
    title: "Sécurité applicative",
    desc: "Cookies sensibles HttpOnly, protections anti-falsification, en-têtes de sécurité, gestion stricte des secrets et limitation des logs contenant des données personnelles.",
    badge: "RGPD · DPA",
    badgeBg: "bg-rose-50 text-rose-700 border-rose-100",
    details: [
      "Cookies sensibles HttpOnly",
      "Protections anti-falsification",
      "En-têtes sécurité HTTP",
      "Logs minimisés (RGPD)",
    ],
  },
];

const useCases = [
  {
    icon: <Zap size={20} />,
    gradient: "from-blue-600 to-indigo-600",
    profile: "TPE / Indépendants",
    desc: "Automatisez la production, réduisez les erreurs de saisie et gardez une vue claire des encaissements.",
  },
  {
    icon: <Users size={20} />,
    gradient: "from-emerald-600 to-teal-500",
    profile: "PME multi-utilisateurs",
    desc: "Collaborez entre direction, comptabilité et opérationnels avec rôles, traces et exports unifiés.",
  },
  {
    icon: <TrendingUp size={20} />,
    gradient: "from-violet-600 to-purple-600",
    profile: "Scale-up / ETI",
    desc: "Structurez les flux documentaires, préparez la réforme 2026-2027 et connectez votre système de transmission.",
  },
];

const roadmapItems = [
  { icon: <Bell size={16} />, label: "Centre d'alertes intelligent", desc: "Rejets, factures bloquées, échéances." },
  {
    icon: <LineChart size={16} />,
    label: "Dashboard KPI financier",
    desc: "DSO, relances, taux de rejet — temps réel.",
  },
  {
    icon: <Import size={16} />,
    label: "Assistant de migration",
    desc: "Import assisté client/articles + déduplication.",
  },
  { icon: <MessageSquare size={16} />, label: "Workspace équipe", desc: "Commentaires internes sur devis/factures." },
];

const highlights = [
  "Factur‑X / UBL / CII",
  "Chorus Pro (B2G) si configuré",
  "Contrôles + audit + exports",
  "Mode connecté ou export",
];

export function FeaturesPage() {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <LegalLayout>
      <div className="max-w-[1200px] mx-auto px-6 pb-24">
        {/* Header */}
        <div className="py-16 mb-4">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 mb-4">
                Fonctionnalités produit
              </span>
              <h1 className="text-[38px] md:text-[52px] font-bold text-slate-900 leading-[1.1] tracking-tight mb-5">
                Interface pensée pour la performance et la conformité
              </h1>
              <p className="text-[17px] text-slate-500 max-w-2xl mb-8 leading-relaxed">
                Produire vite, réduire les erreurs et garder une traçabilité exploitable par les équipes finance,
                direction et conformité.
              </p>

              {/* Highlights */}
              <div className="flex flex-wrap gap-2 mb-8">
                {highlights.map((h) => (
                  <span
                    key={h}
                    className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3.5 py-1.5 rounded-full border"
                    style={{
                      background: "rgba(29,78,216,0.06)",
                      borderColor: "rgba(29,78,216,0.15)",
                      color: "#1d4ed8",
                    }}
                  >
                    <CheckCircle2 size={11} /> {h}
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap gap-3">
                <motion.a
                  href="/app/register"
                  className="inline-flex items-center gap-2 text-white px-6 py-3 rounded-xl text-[14px] font-semibold border-none cursor-pointer"
                  style={{ background: "linear-gradient(135deg, #1d4ed8, #3b82f6)" }}
                  whileHover={{ scale: 1.03, boxShadow: "0 8px 24px rgba(29,78,216,0.35)" }}
                  whileTap={{ scale: 0.97 }}
                >
                  Tester gratuitement <ArrowRight size={14} />
                </motion.a>
                <Link
                  to="/pricing"
                  className="inline-flex items-center gap-2 bg-white border text-slate-700 px-6 py-3 rounded-xl text-[14px] font-medium cursor-pointer hover:border-blue-200 transition-colors"
                  style={{ border: "1px solid #e2e8f0" }}
                >
                  Voir les plans
                </Link>
              </div>
            </div>

            {/* Illustration */}
            <motion.div
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
              className="rounded-2xl overflow-hidden aspect-[16/10] hidden lg:block"
              style={{ border: "1px solid #e2e8f0", boxShadow: "0 16px 48px rgba(0,0,0,0.07)" }}
            >
              <WorkflowIllustration />
            </motion.div>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px mb-12" style={{ background: "#e2e8f0" }} />

        {/* Features grid */}
        <div className="mb-16">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400 mb-2 block">
            Capacités clés
          </span>
          <h2 className="text-[26px] font-bold text-slate-900 mb-2">Ce que vous gagnez</h2>
          <p className="text-[14px] text-slate-500 mb-8 max-w-xl leading-relaxed">
            Le socle fonctionnel pour lancer et faire évoluer votre facturation B2B.
          </p>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f, i) => (
              <motion.div
                key={i}
                className={`bg-white rounded-2xl p-6 border flex flex-col gap-4 cursor-pointer ${
                  expanded === i ? "border-blue-300 shadow-lg" : "border-slate-200"
                }`}
                style={{ boxShadow: expanded === i ? "0 8px 32px rgba(29,78,216,0.1)" : "0 1px 3px rgba(0,0,0,0.03)" }}
                onClick={() => setExpanded(expanded === i ? null : i)}
                whileHover={{ y: -4, boxShadow: "0 16px 40px rgba(0,0,0,0.08)" }}
                transition={{ type: "spring", stiffness: 280, damping: 22 }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div
                    className={`w-11 h-11 rounded-xl bg-gradient-to-br ${f.gradient} flex items-center justify-center text-white shadow-md shrink-0`}
                  >
                    {f.icon}
                  </div>
                  <span className={`self-start text-[11px] font-medium px-2.5 py-1 rounded-xl border ${f.badgeBg}`}>
                    {f.badge}
                  </span>
                </div>
                <div>
                  <h3 className="text-[15px] font-bold text-slate-900 mb-1.5">{f.title}</h3>
                  <p className="text-[13px] text-slate-500 leading-[1.7]">{f.desc}</p>
                </div>
                <AnimatePresence>
                  {expanded === i && (
                    <motion.ul
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="flex flex-col gap-1.5 pt-3 overflow-hidden"
                      style={{ borderTop: "1px solid #f1f5f9" }}
                    >
                      {f.details.map((d, j) => (
                        <li key={j} className="flex items-center gap-2 text-[12px] text-slate-600">
                          <CheckCircle2 size={12} className="text-blue-600 shrink-0" /> {d}
                        </li>
                      ))}
                    </motion.ul>
                  )}
                </AnimatePresence>
                <button className="text-[11px] font-medium text-blue-600 mt-auto text-left bg-transparent border-none cursor-pointer flex items-center gap-1">
                  {expanded === i ? (
                    <>
                      <ChevronUp size={12} /> Réduire
                    </>
                  ) : (
                    <>
                      <ChevronDown size={12} /> Voir le détail
                    </>
                  )}
                </button>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Use cases */}
        <div className="mb-16">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400 mb-2 block">
            Cas d'usage
          </span>
          <h2 className="text-[26px] font-bold text-slate-900 mb-2">La même base produit, adaptée</h2>
          <p className="text-[14px] text-slate-500 mb-8 max-w-xl leading-relaxed">
            Selon le niveau de maturité de votre entreprise.
          </p>
          <div className="grid md:grid-cols-3 gap-5">
            {useCases.map((uc, i) => (
              <motion.div
                key={i}
                className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-col gap-4"
                style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}
                whileHover={{ y: -4, boxShadow: "0 16px 40px rgba(0,0,0,0.08)", borderColor: "#bfdbfe" }}
                transition={{ type: "spring", stiffness: 280, damping: 20 }}
              >
                <div
                  className={`w-11 h-11 rounded-xl bg-gradient-to-br ${uc.gradient} flex items-center justify-center text-white shadow-md shrink-0`}
                >
                  {uc.icon}
                </div>
                <h3 className="text-[16px] font-bold text-slate-900">{uc.profile}</h3>
                <p className="text-[13px] text-slate-500 leading-[1.7]">{uc.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Roadmap */}
        <div className="mb-16">
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400 mb-2 block">
            Pistes d'amélioration
          </span>
          <h2 className="text-[26px] font-bold text-slate-900 mb-2">Roadmap indicative</h2>
          <p className="text-[14px] text-slate-500 mb-8 max-w-xl leading-relaxed">
            Fonctionnalités en développement ou planifiées.
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            {roadmapItems.map((item, i) => (
              <div
                key={i}
                className="flex items-start gap-4 bg-white border border-slate-200 rounded-2xl p-5"
                style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}
              >
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-amber-600"
                  style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)" }}
                >
                  {item.icon}
                </div>
                <div className="flex-1">
                  <p className="text-[14px] font-bold text-slate-900 mb-0.5">{item.label}</p>
                  <p className="text-[12px] text-slate-500">{item.desc}</p>
                </div>
                <span
                  className="text-[10px] font-bold px-2.5 py-1 rounded-full shrink-0 self-start"
                  style={{ background: "rgba(245,158,11,0.1)", color: "#d97706" }}
                >
                  Roadmap
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Transparency */}
        <div className="mb-12 rounded-2xl p-7" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400 mb-2 block">
            Transparence
          </span>
          <h2 className="text-[22px] font-bold text-slate-900 mb-5">
            Ce que nous faisons — et ce que nous ne faisons pas
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-white rounded-xl p-5" style={{ border: "1px solid #dcfce7" }}>
              <p className="text-[11px] font-bold text-emerald-700 uppercase tracking-widest mb-4 flex items-center gap-2">
                <CheckCircle2 size={13} /> Ce que nous faisons
              </p>
              <ul className="flex flex-col gap-2.5">
                {[
                  "Logiciel de facturation B2B pour génération PDF et export Factur‑X / EN16931 avec Pro",
                  "Pré-validation avant émission",
                  "Contrôle des 4 mentions obligatoires",
                  "Exports et traces techniques complets",
                  "Connexion PA partenaire via activation gérée",
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[13px] text-slate-700">
                    <CheckCircle2 size={14} className="text-emerald-600 mt-0.5 shrink-0" /> {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-white rounded-xl p-5" style={{ border: "1px solid #fee2e2" }}>
              <p className="text-[11px] font-bold text-rose-700 uppercase tracking-widest mb-4">
                ✕ Ce que nous ne faisons pas
              </p>
              <ul className="flex flex-col gap-2.5">
                {[
                  "Nous ne sommes pas une PA (ex‑PDP) immatriculée",
                  "Nous ne gérons pas l'immatriculation de plateforme",
                  "Nous ne transmettons pas sans PA choisie",
                  "Nous ne fournissons pas de conseil fiscal/juridique",
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[13px] text-slate-500">
                    <span className="text-rose-400 mt-0.5 shrink-0">✕</span> {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Sources */}
        <div className="mb-12 pt-6" style={{ borderTop: "1px solid #e2e8f0" }}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-400 mb-3">
            Sources officielles
          </p>
          <p className="text-[13px] text-slate-500 mb-4 max-w-2xl leading-relaxed">
            Nous ne fournissons pas de conseil fiscal/juridique. Les fonctionnalités liées à la réforme dépendent des
            spécifications officielles et des plateformes agréées.
          </p>
          <div className="flex flex-col gap-2.5">
            {[
              {
                label: "Spécifications externes B2B (DGFiP) — impots.gouv.fr",
                href: "https://www.impots.gouv.fr/specifications-externes-b2b",
              },
              {
                label: "Liste officielle des plateformes agréées (PA, ex‑PDP)",
                href: "https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees",
              },
              {
                label: "Calendrier officiel — economie.gouv.fr",
                href: "https://www.economie.gouv.fr/tout-savoir-sur-la-facturation-electronique-pour-les-entreprises",
              },
            ].map((s) => (
              <a
                key={s.href}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-blue-600 hover:text-blue-700 hover:underline underline-offset-2"
              >
                {s.label} <ExternalLink size={11} />
              </a>
            ))}
          </div>
        </div>

        {/* Bottom CTA */}
        <div
          className="rounded-3xl p-10 md:p-12 text-center overflow-hidden relative"
          style={{ background: "linear-gradient(135deg, #0f1e36 0%, #1e3a8a 60%, #1d4ed8 100%)" }}
        >
          <div
            className="absolute inset-0 opacity-[0.04]"
            style={{
              backgroundImage:
                "linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)",
              backgroundSize: "48px 48px",
            }}
          />
          <div className="relative z-10 max-w-lg mx-auto">
            <h2 className="text-[26px] md:text-[32px] font-bold text-white mb-3">Prêt à démarrer ?</h2>
            <p className="text-[14px] mb-7 leading-[1.7]" style={{ color: "rgba(147,197,253,0.85)" }}>
              Créez votre compte en mode export et activez les fonctionnalités selon vos besoins.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <motion.a
                href="/app/register"
                className="inline-flex items-center justify-center gap-2 bg-white text-blue-700 px-6 py-3.5 rounded-2xl text-[14px] font-bold border-none cursor-pointer"
                whileHover={{ scale: 1.04, boxShadow: "0 12px 32px rgba(255,255,255,0.2)" }}
                whileTap={{ scale: 0.97 }}
              >
                Créer un compte <ArrowRight size={15} />
              </motion.a>
              <Link
                to="/pricing"
                className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-2xl text-[14px] font-semibold text-white cursor-pointer transition-colors"
                style={{ background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)" }}
              >
                Voir les offres
              </Link>
            </div>
          </div>
        </div>
      </div>
    </LegalLayout>
  );
}
