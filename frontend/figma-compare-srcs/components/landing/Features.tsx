import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowRight, FileCheck, Inbox, Building2, BarChart2, Archive, ShieldCheck } from "lucide-react";
import { AnimatedSection, Tilt3DCard } from "./AnimatedSection";
import { Link } from "react-router";

const features = [
  {
    icon: <FileCheck size={22} />,
    gradient: "from-blue-500 to-indigo-600",
    accent: "rgba(59,130,246,0.15)",
    accentBorder: "rgba(59,130,246,0.25)",
    title: "Facturation B2B Factur‑X",
    desc: "Créez, validez et exportez en Factur‑X (PDF + XML). Contrôles de cohérence, validation XSD/Schematron, gestion TVA, numérotation, export CSV/journal.",
    badge: "Core",
    badgeBg: "bg-blue-500/15 text-blue-300 border-blue-500/20",
    category: "Facturation",
    highlight: true,
  },
  {
    icon: <Inbox size={22} />,
    gradient: "from-sky-500 to-cyan-500",
    accent: "rgba(14,165,233,0.15)",
    accentBorder: "rgba(14,165,233,0.2)",
    title: "Réception & statuts",
    desc: "Activez la réception des factures et le suivi du cycle de vie avec un mandat confirmé explicitement depuis l’app. Mode export disponible sans activation.",
    badge: "Activation app",
    badgeBg: "bg-sky-500/15 text-sky-300 border-sky-500/20",
    category: "Facturation",
    highlight: false,
  },
  {
    icon: <Building2 size={22} />,
    gradient: "from-slate-500 to-slate-600",
    accent: "rgba(100,116,139,0.15)",
    accentBorder: "rgba(100,116,139,0.2)",
    title: "Chorus Pro (B2G)",
    desc: "Connecteur PISTE pour les marchés publics. Identifiants et paramètres requis côté client. Activation selon configuration.",
    badge: "Si configuré",
    badgeBg: "bg-slate-500/15 text-slate-300 border-slate-500/20",
    category: "Conformité",
    highlight: false,
  },
  {
    icon: <BarChart2 size={22} />,
    gradient: "from-amber-500 to-orange-500",
    accent: "rgba(245,158,11,0.15)",
    accentBorder: "rgba(245,158,11,0.2)",
    title: "E‑reporting",
    desc: "En préparation. Mode export disponible ; automatisation via connecteur partenaire selon périmètre (B2C, international, paiements).",
    badge: "Roadmap 2026",
    badgeBg: "bg-amber-500/15 text-amber-300 border-amber-500/20",
    category: "Conformité",
    highlight: false,
  },
  {
    icon: <Archive size={22} />,
    gradient: "from-emerald-500 to-teal-500",
    accent: "rgba(16,185,129,0.15)",
    accentBorder: "rgba(16,185,129,0.2)",
    title: "Archivage & réversibilité",
    desc: "Stockage S3 compatible, rétention paramétrable. Export Factur‑X/PDF/CSV complet. Archivage renforcé configurable (Object Lock si activé) si activé.",
    badge: "Conservation paramétrable",
    badgeBg: "bg-emerald-500/15 text-emerald-300 border-emerald-500/20",
    category: "Archivage",
    highlight: false,
  },
  {
    icon: <ShieldCheck size={22} />,
    gradient: "from-rose-500 to-pink-500",
    accent: "rgba(244,63,94,0.15)",
    accentBorder: "rgba(244,63,94,0.2)",
    title: "Sécurité & conformité",
    desc: "Cookies sensibles HttpOnly, protection anti-falsification, en-têtes sécurité, gestion secrets, logs RGPD minimisés. Hébergement UE/EEE, DPA disponible.",
    badge: "RGPD · DPA",
    badgeBg: "bg-rose-500/15 text-rose-300 border-rose-500/20",
    category: "Sécurité",
    highlight: false,
  },
];

const TABS = ["Tout", "Facturation", "Conformité", "Archivage", "Sécurité"] as const;
type Tab = (typeof TABS)[number];

const TAB_COLORS: Record<Tab, string> = {
  Tout: "rgba(59,130,246,0.2)",
  Facturation: "rgba(59,130,246,0.2)",
  Conformité: "rgba(245,158,11,0.2)",
  Archivage: "rgba(16,185,129,0.2)",
  Sécurité: "rgba(244,63,94,0.2)",
};

export function Features() {
  const [activeTab, setActiveTab] = useState<Tab>("Tout");

  const filtered = activeTab === "Tout" ? features : features.filter((f) => f.category === activeTab);

  return (
    <section
      id="features"
      className="py-24 md:py-32"
      style={{ background: "linear-gradient(180deg, #070d1a 0%, #0a1628 100%)" }}
    >
      <div className="max-w-[1200px] mx-auto px-6">
        {/* Section header */}
        <AnimatedSection className="text-center mb-12">
          <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-400 mb-4">
            Fonctionnalités produit
          </span>
          <h2 className="text-[36px] md:text-[48px] font-bold text-white leading-[1.1] tracking-tight max-w-2xl mx-auto">
            Interface pensée pour la{" "}
            <span
              style={{
                background: "linear-gradient(90deg, #60a5fa, #818cf8)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              performance
            </span>
          </h2>
          <p className="mt-5 text-[17px] max-w-xl mx-auto leading-relaxed" style={{ color: "rgba(148,163,184,1)" }}>
            Produire vite, réduire les erreurs, garder une traçabilité exploitable. Un socle pour les équipes finance,
            direction et conformité.
          </p>
        </AnimatedSection>

        {/* Category tabs */}
        <AnimatedSection delay={0.1} className="flex justify-center mb-10">
          <div
            className="flex max-w-full flex-wrap items-center justify-center gap-1 p-1.5 rounded-2xl"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            {TABS.map((tab) => (
              <motion.button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className="relative px-4 py-2 rounded-xl text-[13px] font-medium transition-colors border-none cursor-pointer"
                style={{ color: activeTab === tab ? "white" : "rgba(100,116,139,1)", background: "transparent" }}
                whileHover={{ color: "rgba(203,213,225,1)" }}
                whileTap={{ scale: 0.96 }}
              >
                {activeTab === tab && (
                  <motion.div
                    layoutId="feature-tab-bg"
                    className="absolute inset-0 rounded-xl"
                    style={{ background: "rgba(255,255,255,0.09)", border: "1px solid rgba(255,255,255,0.12)" }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  />
                )}
                <span className="relative z-10">{tab}</span>
              </motion.button>
            ))}
          </div>
        </AnimatedSection>

        {/* Features grid */}
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="grid md:grid-cols-2 lg:grid-cols-3 gap-5"
          >
            {filtered.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.07, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              >
                <Tilt3DCard className="h-full">
                  <motion.div
                    className="relative rounded-2xl p-6 h-full flex flex-col gap-4 overflow-hidden cursor-default"
                    style={{
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.07)",
                    }}
                    whileHover={{
                      background: "rgba(255,255,255,0.055)",
                      borderColor: f.accentBorder,
                      boxShadow: `0 20px 60px rgba(0,0,0,0.4), 0 0 0 1px ${f.accentBorder}`,
                    }}
                    transition={{ type: "spring", stiffness: 280, damping: 22 }}
                  >
                    {/* Glow top line */}
                    <motion.div
                      className="absolute top-0 left-0 right-0 h-px"
                      style={{ background: `linear-gradient(90deg, transparent, ${f.accent}, transparent)` }}
                    />

                    {/* Corner accent */}
                    <div
                      className="absolute top-0 right-0 w-24 h-24 pointer-events-none"
                      style={{
                        background: `radial-gradient(circle at 100% 0%, ${f.accent} 0%, transparent 70%)`,
                        opacity: 0.5,
                      }}
                    />

                    {/* Icon */}
                    <div
                      className={`w-11 h-11 rounded-xl bg-gradient-to-br ${f.gradient} flex items-center justify-center text-white shadow-lg shrink-0`}
                      style={{ transform: "translateZ(12px)" }}
                    >
                      {f.icon}
                    </div>

                    <h3 className="text-[15px] font-semibold text-white" style={{ transform: "translateZ(8px)" }}>
                      {f.title}
                    </h3>
                    <p className="text-[13px] leading-[1.7] flex-1" style={{ color: "rgba(100,116,139,1)" }}>
                      {f.desc}
                    </p>

                    <span className={`self-start text-[11px] font-medium px-3 py-1 rounded-full border ${f.badgeBg}`}>
                      {f.badge}
                    </span>
                  </motion.div>
                </Tilt3DCard>
              </motion.div>
            ))}
          </motion.div>
        </AnimatePresence>

        {/* Disclaimer + CTA */}
        <AnimatedSection delay={0.2} className="mt-12">
          <div
            className="flex flex-col md:flex-row items-center justify-between gap-6 pt-8"
            style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}
          >
            <p className="text-[12px] max-w-lg text-center md:text-left" style={{ color: "rgba(71,85,105,1)" }}>
              Nous ne fournissons pas de conseil fiscal ou juridique. Les fonctionnalités liées à la réforme dépendent
              des spécifications officielles et des plateformes agréées.
            </p>
            <div className="flex items-center gap-4 shrink-0">
              <Link
                to="/features"
                className="text-[14px] font-medium transition-colors"
                style={{ color: "rgba(148,163,184,1)" }}
              >
                Voir toutes les fonctionnalités →
              </Link>
              <motion.a
                href="/app/register"
                className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-xl text-[14px] font-semibold border-none cursor-pointer"
                style={{ background: "linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%)" }}
                whileHover={{ scale: 1.04, boxShadow: "0 8px 24px rgba(29,78,216,0.4)" }}
                whileTap={{ scale: 0.97 }}
              >
                Tester gratuitement <ArrowRight size={15} />
              </motion.a>
            </div>
          </div>
        </AnimatedSection>
      </div>
    </section>
  );
}
