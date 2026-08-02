import { useRef } from "react";
import { motion, useInView } from "motion/react";
import { AnimatedSection } from "./AnimatedSection";
import { CheckCircle2, Clock, CalendarDays, Zap, ArrowRight } from "lucide-react";
import { Link } from "react-router";

const milestones = [
  {
    date: "Déc. 2023",
    title: "Décret publié",
    desc: "Le cadre réglementaire est établi. Les spécifications techniques officielles DGFiP sont diffusées.",
    status: "done" as const,
    icon: <CheckCircle2 size={16} />,
    accent: "#10b981",
    accentBg: "rgba(16,185,129,0.12)",
    accentBorder: "rgba(16,185,129,0.25)",
    badge: "Terminé",
  },
  {
    date: "Jan. 2025",
    title: "Réception possible",
    desc: "Toutes les entreprises françaises assujetties à la TVA peuvent recevoir des factures électroniques.",
    status: "done" as const,
    icon: <CheckCircle2 size={16} />,
    accent: "#10b981",
    accentBg: "rgba(16,185,129,0.12)",
    accentBorder: "rgba(16,185,129,0.25)",
    badge: "Terminé",
  },
  {
    date: "Fév. 2026",
    title: "Vous êtes ici",
    desc: "C'est maintenant qu'il faut se préparer. Structurez vos flux, choisissez vos outils, signez les mandats.",
    status: "now" as const,
    icon: <Zap size={16} />,
    accent: "#3b82f6",
    accentBg: "rgba(59,130,246,0.15)",
    accentBorder: "rgba(59,130,246,0.4)",
    badge: "Aujourd'hui",
  },
  {
    date: "Sep. 2026",
    title: "Émission GE & ETI",
    desc: "Réception obligatoire généralisée. Grandes entreprises et ETI doivent émettre via une PA agréée.",
    status: "upcoming" as const,
    icon: <CalendarDays size={16} />,
    accent: "#f59e0b",
    accentBg: "rgba(245,158,11,0.1)",
    accentBorder: "rgba(245,158,11,0.25)",
    badge: "~7 mois",
  },
  {
    date: "Sep. 2027",
    title: "Émission PME & Micro",
    desc: "Toutes les entreprises assujetties à la TVA (PME, micro-entreprises) doivent émettre électroniquement.",
    status: "future" as const,
    icon: <Clock size={16} />,
    accent: "#64748b",
    accentBg: "rgba(100,116,139,0.08)",
    accentBorder: "rgba(100,116,139,0.2)",
    badge: "~19 mois",
  },
];

// Progress: today (Feb 2026) is ~57% through Dec2023→Sep2027
const PROGRESS_PERCENT = 57;

function MilestoneCard({ m, index, total }: { m: typeof milestones[0]; index: number; total: number }) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 32 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6, delay: index * 0.12, ease: [0.22, 1, 0.36, 1] }}
      className="relative flex flex-col"
    >
      {/* Dot on timeline line */}
      <div className="absolute -top-[1px] left-1/2 -translate-x-1/2 -translate-y-full pb-3 hidden lg:flex flex-col items-center">
        <motion.div
          initial={{ scale: 0 }}
          animate={isInView ? { scale: 1 } : {}}
          transition={{ delay: index * 0.12 + 0.2, type: "spring", stiffness: 400, damping: 20 }}
          className="relative"
        >
          {m.status === "now" && (
            <motion.div
              className="absolute -inset-2 rounded-full"
              style={{ background: `radial-gradient(circle, ${m.accentBg}, transparent)` }}
              animate={{ scale: [1, 1.5, 1], opacity: [0.8, 0, 0.8] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
          )}
          <div
            className="w-4 h-4 rounded-full relative z-10 flex items-center justify-center"
            style={{
              background: m.status === "future" ? "rgba(30,41,59,1)" : m.accent,
              border: `2px solid ${m.accentBorder}`,
              boxShadow: m.status === "now" ? `0 0 16px ${m.accent}` : "none",
            }}
          >
            {m.status === "now" && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
          </div>
        </motion.div>
      </div>

      {/* Card */}
      <motion.div
        className="rounded-2xl p-5 flex flex-col gap-3 h-full relative overflow-hidden"
        style={{
          background: m.status === "now"
            ? "rgba(59,130,246,0.08)"
            : "rgba(255,255,255,0.025)",
          border: `1px solid ${m.accentBorder}`,
        }}
        whileHover={{
          background: m.status === "now" ? "rgba(59,130,246,0.12)" : "rgba(255,255,255,0.05)",
          y: -3,
          boxShadow: `0 16px 48px rgba(0,0,0,0.3), 0 0 0 1px ${m.accentBorder}`,
        }}
        transition={{ type: "spring", stiffness: 300, damping: 22 }}
      >
        {/* Corner glow */}
        <div className="absolute top-0 right-0 w-20 h-20 pointer-events-none"
          style={{ background: `radial-gradient(circle at 100% 0%, ${m.accentBg} 0%, transparent 70%)` }} />

        {/* Status badge */}
        <span
          className="self-start text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider"
          style={{ background: m.accentBg, color: m.accent, border: `1px solid ${m.accentBorder}` }}
        >
          {m.badge}
        </span>

        {/* Date */}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: m.accentBg, color: m.accent, border: `1px solid ${m.accentBorder}` }}>
            {m.icon}
          </div>
          <span className="text-[13px] font-bold" style={{ color: m.accent }}>{m.date}</span>
        </div>

        <h3 className="text-[15px] font-bold text-white leading-snug">{m.title}</h3>
        <p className="text-[12px] leading-[1.7] flex-1" style={{ color: "rgba(100,116,139,1)" }}>{m.desc}</p>

        {m.status === "now" && (
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-400">
            <motion.div className="w-1.5 h-1.5 rounded-full bg-blue-400"
              animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.4, repeat: Infinity }} />
            Préparez-vous maintenant
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

export function ReformTimeline() {
  const lineRef = useRef(null);
  const lineInView = useInView(lineRef, { once: true, margin: "-100px" });

  return (
    <section id="reform" className="py-24 md:py-32 relative overflow-hidden"
      style={{ background: "linear-gradient(180deg, #070d1a 0%, #0a1628 100%)" }}>

      {/* Noise texture */}
      <div className="absolute inset-0 opacity-[0.025] pointer-events-none"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          backgroundSize: "180px 180px",
        }} />

      {/* Radial bg */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] pointer-events-none"
        style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(29,78,216,0.08) 0%, transparent 70%)" }} />

      <div className="max-w-[1200px] mx-auto px-6 relative">
        <AnimatedSection className="text-center mb-16">
          <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-400 mb-4">
            Calendrier de la réforme
          </span>
          <h2 className="text-[36px] md:text-[48px] font-bold text-white leading-[1.1] tracking-tight">
            La réforme{" "}
            <span style={{ background: "linear-gradient(90deg, #f59e0b, #fb923c)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
              2026–2027
            </span>
            {" "}c'est maintenant
          </h2>
          <p className="mt-5 text-[17px] max-w-xl mx-auto leading-relaxed" style={{ color: "rgba(148,163,184,1)" }}>
            Chaque étape est connue. Il suffit de s'y préparer au bon moment. Vous êtes à 7 mois de l'obligation pour les GE et ETI.
          </p>
        </AnimatedSection>

        {/* Timeline progress bar - desktop */}
        <div ref={lineRef} className="relative mb-12 hidden lg:block">
          {/* Background line */}
          <div className="absolute top-0 left-0 right-0 h-px"
            style={{ background: "rgba(255,255,255,0.07)" }} />
          {/* Progress line */}
          <motion.div
            className="absolute top-0 left-0 h-px"
            style={{ background: "linear-gradient(90deg, #10b981, #3b82f6, #3b82f6)" }}
            initial={{ width: "0%" }}
            animate={lineInView ? { width: `${PROGRESS_PERCENT}%` } : {}}
            transition={{ duration: 1.5, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
          />
          {/* Spacer */}
          <div className="h-6" />
        </div>

        {/* Milestones grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 lg:gap-5 lg:pt-2">
          {milestones.map((m, i) => (
            <MilestoneCard key={i} m={m} index={i} total={milestones.length} />
          ))}
        </div>

        {/* Bottom info + CTA */}
        <AnimatedSection delay={0.5} className="mt-12">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6 pt-8"
            style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
            <div className="flex flex-wrap items-center gap-6">
              {[
                { dot: "#10b981", label: "Obligation passée" },
                { dot: "#3b82f6", label: "Situation actuelle" },
                { dot: "#f59e0b", label: "Prochaine échéance" },
                { dot: "#475569", label: "Échéance future" },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: item.dot }} />
                  <span className="text-[12px]" style={{ color: "rgba(100,116,139,1)" }}>{item.label}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <a href="https://www.economie.gouv.fr/tout-savoir-sur-la-facturation-electronique-pour-les-entreprises"
                target="_blank" rel="noopener noreferrer"
                className="text-[13px] text-blue-400 hover:text-blue-300 transition-colors">
                Source officielle →
              </a>
              <motion.a
                href="/app/register"
                className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-xl text-[13px] font-semibold border-none cursor-pointer"
                style={{ background: "linear-gradient(135deg, #1d4ed8, #3b82f6)" }}
                whileHover={{ scale: 1.04, boxShadow: "0 8px 24px rgba(29,78,216,0.4)" }}
                whileTap={{ scale: 0.97 }}
              >
                Se préparer maintenant <ArrowRight size={14} />
              </motion.a>
            </div>
          </div>
        </AnimatedSection>
      </div>
    </section>
  );
}
