"use client";
import { useMemo, useRef, type ReactNode } from "react";
import { motion, useInView } from "motion/react";
import { AnimatedSection } from "./AnimatedSection";
import { CheckCircle2, Clock, CalendarDays, Zap, ArrowRight } from "lucide-react";
import { Link } from "@/figma/react-router-compat";
import { buildReformTimelineState } from "@/lib/complianceTimeline";

type MilestoneStatus = "done" | "now" | "upcoming" | "future";

type Milestone = {
  sortAt: number;
  date: string;
  title: string;
  desc: string;
  status: MilestoneStatus;
  icon: ReactNode;
  accent: string;
  accentBg: string;
  accentBorder: string;
  badge: string;
};

const reformEvents = [
  {
    sortAt: Date.UTC(2023, 11, 1),
    date: "Déc. 2023",
    title: "Calendrier fixé",
    desc: "Le déploiement obligatoire est organisé en deux échéances : septembre 2026 puis septembre 2027.",
    deadline: null,
  },
  {
    sortAt: Date.UTC(2025, 6, 1),
    date: "Juil. 2025",
    title: "Échanges volontaires",
    desc: "Les premiers échanges aux formats attendus démarrent sur la base du volontariat avec les plateformes agréées.",
    deadline: null,
  },
  {
    sortAt: Date.UTC(2026, 8, 1),
    date: "Sept. 2026",
    title: "Réception générale · émission GE/ETI",
    desc: "Réception obligatoire généralisée. Grandes entreprises et ETI doivent émettre via une plateforme agréée.",
    deadline: "first",
  },
  {
    sortAt: Date.UTC(2027, 8, 1),
    date: "Sept. 2027",
    title: "Émission PME & Micro",
    desc: "Toutes les entreprises assujetties à la TVA (PME, micro-entreprises) doivent émettre électroniquement.",
    deadline: "second",
  },
] as const;

function milestoneVisual(status: MilestoneStatus) {
  if (status === "done") {
    return {
      icon: <CheckCircle2 size={16} />,
      accent: "#10b981",
      accentBg: "rgba(16,185,129,0.12)",
      accentBorder: "rgba(16,185,129,0.25)",
    };
  }
  if (status === "now") {
    return {
      icon: <Zap size={16} />,
      accent: "#3b82f6",
      accentBg: "rgba(59,130,246,0.15)",
      accentBorder: "rgba(59,130,246,0.4)",
    };
  }
  if (status === "upcoming") {
    return {
      icon: <CalendarDays size={16} />,
      accent: "#f59e0b",
      accentBg: "rgba(245,158,11,0.1)",
      accentBorder: "rgba(245,158,11,0.25)",
    };
  }
  return {
    icon: <Clock size={16} />,
    accent: "#64748b",
    accentBg: "rgba(100,116,139,0.08)",
    accentBorder: "rgba(100,116,139,0.2)",
  };
}

function buildMilestones(now: Date) {
  const timelineState = buildReformTimelineState(now);
  const pending = reformEvents.filter((event) => event.sortAt > timelineState.nowTimestamp);
  const nextPendingAt = pending.length ? Math.min(...pending.map((event) => event.sortAt)) : null;
  const dated: Milestone[] = reformEvents.map((event) => {
    const status: MilestoneStatus =
      event.sortAt <= timelineState.nowTimestamp ? "done" : event.sortAt === nextPendingAt ? "upcoming" : "future";
    const badge =
      status === "done"
        ? event.deadline
          ? "En vigueur"
          : "Terminé"
        : event.deadline === "first"
          ? timelineState.firstDeadlineBadge
          : event.deadline === "second"
            ? timelineState.secondDeadlineBadge
            : "À venir";
    return { ...event, status, badge, ...milestoneVisual(status) };
  });

  dated.push({
    sortAt: timelineState.nowTimestamp,
    date: timelineState.currentDateLabel,
    title: "Vous êtes ici",
    desc: "C'est maintenant qu'il faut se préparer. Structurez vos flux, choisissez vos outils et signez les mandats nécessaires.",
    status: "now",
    badge: "Aujourd'hui",
    ...milestoneVisual("now"),
  });

  return { timelineState, milestones: dated.sort((left, right) => left.sortAt - right.sortAt) };
}

function MilestoneCard({ m, index }: { m: Milestone; index: number }) {
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
          background: m.status === "now" ? "rgba(59,130,246,0.08)" : "rgba(255,255,255,0.025)",
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
        <div
          className="absolute top-0 right-0 w-20 h-20 pointer-events-none"
          style={{ background: `radial-gradient(circle at 100% 0%, ${m.accentBg} 0%, transparent 70%)` }}
        />

        {/* Status badge */}
        <span
          className="self-start text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider"
          style={{ background: m.accentBg, color: m.accent, border: `1px solid ${m.accentBorder}` }}
        >
          {m.badge}
        </span>

        {/* Date */}
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: m.accentBg, color: m.accent, border: `1px solid ${m.accentBorder}` }}
          >
            {m.icon}
          </div>
          <span className="text-[13px] font-bold" style={{ color: m.accent }}>
            {m.date}
          </span>
        </div>

        <h3 className="text-[15px] font-bold text-white leading-snug">{m.title}</h3>
        <p className="text-[12px] leading-[1.7] flex-1" style={{ color: "rgba(100,116,139,1)" }}>
          {m.desc}
        </p>

        {m.status === "now" && (
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-400">
            <motion.div
              className="w-1.5 h-1.5 rounded-full bg-blue-400"
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.4, repeat: Infinity }}
            />
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
  const { timelineState, milestones } = useMemo(() => buildMilestones(new Date()), []);

  return (
    <section
      id="reform"
      className="py-24 md:py-32 relative overflow-hidden"
      style={{ background: "linear-gradient(180deg, #070d1a 0%, #0a1628 100%)" }}
    >
      {/* Noise texture */}
      <div
        className="absolute inset-0 opacity-[0.025] pointer-events-none"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          backgroundSize: "180px 180px",
        }}
      />

      {/* Radial bg */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] pointer-events-none"
        style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(29,78,216,0.08) 0%, transparent 70%)" }}
      />

      <div className="max-w-[1240px] mx-auto px-6 md:px-8 relative">
        <AnimatedSection className="mb-16 flex flex-col items-center text-center">
          <div className="mx-auto flex w-full max-w-[820px] flex-col items-center gap-6">
            <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] leading-none text-blue-300">
              Calendrier de la réforme
            </span>
            <h2
              aria-label="La réforme 2026–2027 c'est maintenant"
              className="max-w-[800px] text-4xl font-bold tracking-tight text-white md:text-5xl leading-[1.08]"
            >
              La réforme{" "}
              <span
                style={{
                  background: "linear-gradient(90deg, #f59e0b, #fb923c)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}
              >
                2026–2027
              </span>{" "}
              c'est maintenant
            </h2>
            <p className="max-w-[760px] text-[17px] leading-relaxed" style={{ color: "rgba(203,213,225,0.9)" }}>
              {timelineState.intro}
            </p>
          </div>
        </AnimatedSection>

        {/* Timeline progress bar - desktop */}
        <div ref={lineRef} className="relative mb-12 hidden lg:block">
          {/* Background line */}
          <div className="absolute top-0 left-0 right-0 h-px" style={{ background: "rgba(255,255,255,0.07)" }} />
          {/* Progress line */}
          <motion.div
            className="absolute top-0 left-0 h-px"
            style={{ background: "linear-gradient(90deg, #10b981, #3b82f6, #3b82f6)" }}
            initial={{ width: "0%" }}
            animate={lineInView ? { width: `${timelineState.progressPercent}%` } : {}}
            transition={{ duration: 1.5, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
          />
          {/* Spacer */}
          <div className="h-6" />
        </div>

        {/* Milestones grid */}
        <div className="mx-auto grid w-full max-w-[1240px] grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:gap-5 lg:pt-2">
          {milestones.map((m, i) => (
            <MilestoneCard key={`${m.date}-${m.title}`} m={m} index={i} />
          ))}
        </div>

        {/* Bottom info + CTA */}
        <AnimatedSection delay={0.5} className="mx-auto mt-12 w-full max-w-[1240px]">
          <div
            className="flex flex-col md:flex-row items-center justify-between gap-6 pt-8"
            style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}
          >
            <div className="flex flex-wrap items-center gap-6">
              {[
                { dot: "#10b981", label: "Obligation passée" },
                { dot: "#3b82f6", label: "Situation actuelle" },
                { dot: "#f59e0b", label: "Prochaine échéance" },
                { dot: "#475569", label: "Échéance future" },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: item.dot }} />
                  <span className="text-[12px]" style={{ color: "rgba(100,116,139,1)" }}>
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <a
                href="https://www.impots.gouv.fr/professionnel/je-passe-la-facturation-electronique"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] text-blue-400 hover:text-blue-300 transition-colors"
              >
                Source officielle →
              </a>
              <motion.a
                href="/app/register?plan=pro"
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
