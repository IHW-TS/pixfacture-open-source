"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowRight, FileCheck, Inbox, Building2, BarChart2, Archive, ShieldCheck } from "lucide-react";
import { AnimatedSection, Tilt3DCard } from "./AnimatedSection";
import { Link } from "@/figma/react-router-compat";

const features = [
  {
    icon: <FileCheck size={22} />,
    gradient: "from-blue-500 to-indigo-600",
    accent: "rgba(59,130,246,0.15)",
    accentBorder: "rgba(59,130,246,0.25)",
    title: "Facturation B2B",
    desc: "Créez vos devis et factures PDF en Starter. Factur‑X et contrôles avancés sont disponibles avec Pro; la transmission exige contrat, mandat et connecteur actif.",
    badge: "Starter + Pro",
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
    desc: "Préparez la réception des factures et le suivi du cycle de vie avec Pro, mandat/contrat PA et configuration validée.",
    badge: "Pro · Activation",
    badgeBg: "bg-sky-500/15 text-sky-300 border-sky-500/20",
    category: "Facturation",
    highlight: false,
  },
  {
    icon: <Building2 size={22} />,
    gradient: "from-slate-500 to-slate-600",
    accent: "rgba(100,116,139,0.15)",
    accentBorder: "rgba(100,116,139,0.2)",
    title: "Canal public (B2G)",
    desc: "Connecteur PISTE/Chorus réservé à Pro pour les marchés publics. Identifiants et paramètres requis côté client.",
    badge: "Pro · Si configuré",
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
    desc: "Export disponible en Pro. Transmission PA selon activation partenaire, mandat et périmètre.",
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
    desc: "Stockage et rétention paramétrables selon configuration. PDF/CSV en Starter ; Factur‑X en Pro si disponible ; export complet de réversibilité.",
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
    desc: "Cookies sensibles HttpOnly, protection anti-falsification, en-têtes sécurité, gestion secrets, logs RGPD minimisés. Hébergement selon instance, DPA disponible.",
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
      <div className="max-w-[1240px] mx-auto px-6 md:px-8">
        {/* Section header */}
        <AnimatedSection className="mb-12 flex flex-col items-center text-center">
          <div className="mx-auto flex w-full max-w-[820px] flex-col items-center gap-6">
            <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] leading-none text-blue-300">
              Fonctionnalités produit
            </span>
            <h2
              aria-label="Interface pensée pour la performance"
              className="max-w-[800px] text-4xl font-bold tracking-tight text-white md:text-5xl leading-[1.08]"
            >
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
            <p className="max-w-[760px] text-[17px] leading-relaxed" style={{ color: "rgba(203,213,225,0.9)" }}>
              Produire vite, réduire les erreurs, garder une traçabilité exploitable. Un socle pour les équipes finance,
              direction et conformité.
            </p>
          </div>
        </AnimatedSection>

        {/* Category tabs */}
        <AnimatedSection delay={0.1} className="flex justify-center mb-10">
          <div
            className="flex max-w-full flex-wrap items-center justify-center gap-1 p-1.5 rounded-2xl"
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
          >
            {TABS.map((tab) => (
              <motion.button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className="relative px-4 py-2 rounded-xl text-[13px] font-medium transition-colors border-none cursor-pointer"
                style={{ color: activeTab === tab ? "white" : "rgba(186,200,219,0.92)", background: "transparent" }}
                whileHover={{ color: "rgba(203,213,225,1)" }}
                whileTap={{ scale: 0.96 }}
              >
                {activeTab === tab && (
                  <motion.div
                    layoutId="feature-tab-bg"
                    className="absolute inset-0 rounded-xl"
                    style={{ background: "rgba(255,255,255,0.11)", border: "1px solid rgba(255,255,255,0.14)" }}
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
            className="mx-auto grid w-full max-w-[1240px] gap-5 md:grid-cols-2 lg:grid-cols-3"
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
                      background: "rgba(255,255,255,0.045)",
                      border: "1px solid rgba(255,255,255,0.1)",
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
                    <p className="text-[13px] leading-[1.7] flex-1" style={{ color: "rgba(203,213,225,0.88)" }}>
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
        <AnimatedSection delay={0.2} className="mx-auto mt-12 w-full max-w-[1240px]">
          <div
            className="flex flex-col md:flex-row items-center justify-between gap-6 pt-8"
            style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}
          >
            <p className="text-[12px] max-w-lg text-center md:text-left" style={{ color: "rgba(148,163,184,0.9)" }}>
              Nous ne fournissons pas de conseil fiscal ou juridique. Les fonctionnalités liées à la réforme dépendent
              des spécifications officielles et des plateformes agréées.
            </p>
            <div className="flex items-center gap-4 shrink-0">
              <Link
                to="/features"
                className="text-[14px] font-medium transition-colors"
                style={{ color: "rgba(191,219,254,0.92)" }}
              >
                Voir toutes les fonctionnalités →
              </Link>
              <motion.a
                href="/app/register?plan=pro"
                className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-xl text-[14px] font-semibold border-none cursor-pointer"
                style={{ background: "linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)" }}
                whileHover={{ scale: 1.04, boxShadow: "0 8px 24px rgba(29,78,216,0.4)" }}
                whileTap={{ scale: 0.97 }}
              >
                Essayer gratuitement <ArrowRight size={15} />
              </motion.a>
            </div>
          </div>
        </AnimatedSection>
      </div>
    </section>
  );
}
