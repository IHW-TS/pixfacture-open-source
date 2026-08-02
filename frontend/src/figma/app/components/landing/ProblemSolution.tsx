"use client";
import { motion } from "motion/react";
import { Zap, Send, BarChart2, ArrowRight, Info, ShieldCheck } from "lucide-react";
import { AnimatedSection, AnimatedStagger, AnimatedStaggerItem } from "./AnimatedSection";

const valueProps = [
  {
    icon: <Zap size={24} />,
    gradient: "from-blue-500/20 to-indigo-500/10",
    iconBg: "from-blue-600 to-blue-500",
    accent: "#3b82f6",
    title: "Production fiable",
    desc: "Générez des factures PDF, puis des exports Factur‑X/CII avec Pro et UBL selon activation. Contrôles de cohérence et numérotation séquentielle.",
    tag: "Factur‑X/CII · UBL selon activation",
    tagBg: "bg-blue-500/10 text-blue-300 border-blue-500/20",
    metrics: [
      { label: "Formats supportés", value: "3" },
      { label: "Contrôles", value: "Selon format" },
    ],
  },
  {
    icon: <Send size={24} />,
    gradient: "from-sky-500/20 to-cyan-500/10",
    iconBg: "from-sky-600 to-cyan-500",
    accent: "#0ea5e9",
    title: "Transmission cadrée",
    desc: "Connecteur vers plateforme agréée (PA, ex‑PDP) disponible avec Pro après mandat, contrat et configuration. Les exports restent soumis au plan et aux contrôles activés.",
    tag: "Connecteur Pro · Export",
    tagBg: "bg-sky-500/10 text-sky-300 border-sky-500/20",
    metrics: [
      { label: "Mode connecté", value: "Pro" },
      { label: "Export", value: "Selon plan" },
    ],
  },
  {
    icon: <BarChart2 size={24} />,
    gradient: "from-emerald-500/20 to-teal-500/10",
    iconBg: "from-emerald-600 to-teal-500",
    accent: "#10b981",
    title: "Visibilité opérationnelle",
    desc: "Journal d'audit, statuts de transmission et exports comptables. Traçabilité claire pour vos équipes finance.",
    tag: "Audit continu · RGPD",
    tagBg: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
    metrics: [
      { label: "Rétention", value: "Paramétrable" },
      { label: "Journal ventes", value: "✓" },
    ],
  },
];

export function ProblemSolution() {
  return (
    <section className="py-24 md:py-32 relative overflow-hidden" style={{ background: "#f8fafc" }}>
      {/* Subtle background accent */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] pointer-events-none"
        style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(29,78,216,0.06) 0%, transparent 70%)" }}
      />

      <div className="max-w-[1240px] mx-auto px-6 md:px-8 relative">
        <AnimatedSection className="mb-16 flex flex-col items-center text-center">
          <div className="mx-auto flex w-full max-w-[820px] flex-col items-center gap-6">
            <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] leading-none text-blue-700">
              Pourquoi choisir notre solution
            </span>
            <h2
              aria-label="Produire, transmettre et suivre sans ambiguïté"
              className="max-w-[780px] text-4xl font-bold tracking-tight text-slate-900 md:text-5xl leading-[1.08]"
            >
              Produire, transmettre et suivre{" "}
              <span className="relative">
                <span
                  style={{
                    background: "linear-gradient(90deg, #1d4ed8, #0ea5e9)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                  }}
                >
                  sans ambiguïté
                </span>
              </span>
            </h2>
            <p className="max-w-[760px] text-[17px] leading-relaxed text-slate-600">
              L'interface met en avant les décisions importantes. Une vue claire des flux documentaires, de l'émission
              au suivi comptable.
            </p>
          </div>
        </AnimatedSection>

        <AnimatedStagger className="mx-auto grid w-full max-w-[1240px] gap-6 md:grid-cols-3">
          {valueProps.map((p, i) => (
            <AnimatedStaggerItem key={i}>
              <motion.div
                className={`relative rounded-2xl p-7 h-full flex flex-col gap-5 overflow-hidden bg-white`}
                style={{ border: "1px solid #dbe3f1", boxShadow: "0 10px 32px rgba(15,23,42,0.06)" }}
                whileHover={{
                  y: -6,
                  boxShadow: `0 24px 64px rgba(0,0,0,0.08), 0 0 0 1px rgba(${p.accent
                    .replace("#", "")
                    .match(/.{2}/g)
                    ?.map((h) => parseInt(h, 16))
                    .join(",")},0.15)`,
                }}
                transition={{ type: "spring", stiffness: 280, damping: 20 }}
              >
                {/* Gradient bg */}
                <div className={`absolute inset-0 bg-gradient-to-br ${p.gradient} opacity-50 pointer-events-none`} />

                {/* Icon */}
                <div className="relative">
                  <div
                    className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${p.iconBg} flex items-center justify-center text-white shadow-lg`}
                  >
                    {p.icon}
                  </div>
                </div>

                {/* Content */}
                <div className="relative flex flex-col gap-3 flex-1">
                  <h3 className="text-[18px] font-bold text-slate-900">{p.title}</h3>
                  <p className="text-[14px] text-slate-600 leading-[1.7] flex-1">{p.desc}</p>

                  {/* Metrics */}
                  <div className="grid grid-cols-2 gap-3 pt-4 mt-2" style={{ borderTop: "1px solid #f1f5f9" }}>
                    {p.metrics.map((m, j) => (
                      <div key={j} className="flex flex-col">
                        <span className="text-[18px] font-bold text-slate-900">{m.value}</span>
                        <span className="text-[11px] text-slate-500 mt-0.5">{m.label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Tag */}
                <span
                  className={`self-start text-[11px] font-medium px-3 py-1 rounded-full border ${p.tagBg} relative`}
                >
                  {p.tag}
                </span>
              </motion.div>
            </AnimatedStaggerItem>
          ))}
        </AnimatedStagger>

        {/* Reform banner */}
        <AnimatedSection delay={0.3} className="mx-auto mt-8 w-full max-w-[1240px]">
          <motion.div
            className="flex flex-col sm:flex-row items-start sm:items-center gap-5 rounded-2xl px-6 py-5 relative overflow-hidden"
            style={{
              border: "1px solid #bfdbfe",
              background: "linear-gradient(135deg, rgba(239,246,255,1) 0%, rgba(255,255,255,1) 100%)",
            }}
            whileHover={{ borderColor: "#93c5fd", boxShadow: "0 8px 32px rgba(29,78,216,0.1)" }}
            transition={{ duration: 0.25 }}
          >
            {/* Subtle left accent */}
            <div
              className="absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl"
              style={{ background: "linear-gradient(180deg, #1d4ed8, #3b82f6)" }}
            />

            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ml-2"
              style={{ background: "linear-gradient(135deg, #1d4ed8, #3b82f6)" }}
            >
              <Info size={18} className="text-white" />
            </div>
            <div className="flex-1">
              <p className="text-[14px] font-semibold text-slate-900 mb-1">Réforme 2026–2027</p>
              <p className="text-[13px] text-slate-600">
                Réception obligatoire pour toutes les entreprises au 1er septembre 2026 ; émission au 1er septembre 2026
                pour les grandes entreprises et ETI, puis au 1er septembre 2027 pour les PME et micro-entreprises.{" "}
                <a
                  href="https://www.impots.gouv.fr/professionnel/je-passe-la-facturation-electronique"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 underline underline-offset-2"
                >
                  Calendrier officiel →
                </a>
              </p>
            </div>
            <motion.div
              className="flex items-center gap-2 text-[13px] text-blue-600 font-medium shrink-0 cursor-pointer"
              whileHover={{ x: 3 }}
              transition={{ type: "spring", stiffness: 400 }}
            >
              <ShieldCheck size={15} />
              <span>Préparation 2026–2027</span>
            </motion.div>
          </motion.div>
        </AnimatedSection>
      </div>
    </section>
  );
}
