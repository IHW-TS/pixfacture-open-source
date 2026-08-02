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
    desc: "Générez des factures conformes en Factur‑X, UBL ou CII. Contrôles de cohérence, mentions obligatoires, numérotation séquentielle.",
    tag: "Factur‑X / UBL / CII",
    tagBg: "bg-blue-500/10 text-blue-300 border-blue-500/20",
    metrics: [
      { label: "Formats supportés", value: "3" },
      { label: "Contrôles auto", value: "12+" },
    ],
  },
  {
    icon: <Send size={24} />,
    gradient: "from-sky-500/20 to-cyan-500/10",
    iconBg: "from-sky-600 to-cyan-500",
    accent: "#0ea5e9",
    title: "Transmission cadrée",
    desc: "Connecteur vers plateforme agréée (PA, ex‑PDP) activable selon votre plan. Mode export disponible sans configuration.",
    tag: "Connecteur PA · Export",
    tagBg: "bg-sky-500/10 text-sky-300 border-sky-500/20",
    metrics: [
      { label: "Mode connecté", value: "✓" },
      { label: "Mode export", value: "✓" },
    ],
  },
  {
    icon: <BarChart2 size={24} />,
    gradient: "from-emerald-500/20 to-teal-500/10",
    iconBg: "from-emerald-600 to-teal-500",
    accent: "#10b981",
    title: "Visibilité opérationnelle",
    desc: "Journal d'audit, statuts de transmission, exports FEC et archivage probant. Traçabilité complète pour vos équipes finance.",
    tag: "Audit continu · RGPD",
    tagBg: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
    metrics: [
      { label: "Archivage fiscal", value: "6 ans" },
      { label: "Export FEC", value: "✓" },
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

      <div className="max-w-[1200px] mx-auto px-6 relative">
        <AnimatedSection className="text-center mb-16">
          <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 mb-4">
            Pourquoi choisir notre solution
          </span>
          <h2 className="text-[36px] md:text-[48px] font-bold text-slate-900 leading-[1.1] tracking-tight max-w-2xl mx-auto">
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
          <p className="mt-5 text-[17px] text-slate-500 max-w-xl mx-auto leading-relaxed">
            L'interface met en avant les décisions importantes. Une vue claire des flux documentaires, de l'émission à
            l'archivage.
          </p>
        </AnimatedSection>

        <AnimatedStagger className="grid md:grid-cols-3 gap-6">
          {valueProps.map((p, i) => (
            <AnimatedStaggerItem key={i}>
              <motion.div
                className={`relative rounded-2xl p-7 h-full flex flex-col gap-5 overflow-hidden bg-white`}
                style={{ border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}
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
                  <p className="text-[14px] text-slate-500 leading-[1.7] flex-1">{p.desc}</p>

                  {/* Metrics */}
                  <div className="grid grid-cols-2 gap-3 pt-4 mt-2" style={{ borderTop: "1px solid #f1f5f9" }}>
                    {p.metrics.map((m, j) => (
                      <div key={j} className="flex flex-col">
                        <span className="text-[18px] font-bold text-slate-900">{m.value}</span>
                        <span className="text-[11px] text-slate-400 mt-0.5">{m.label}</span>
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
        <AnimatedSection delay={0.3} className="mt-8">
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
              <p className="text-[13px] text-slate-500">
                Réception généralisée dès 2026, émission progressive et e‑reporting selon le même calendrier.{" "}
                <a
                  href="https://www.economie.gouv.fr/tout-savoir-sur-la-facturation-electronique-pour-les-entreprises"
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
