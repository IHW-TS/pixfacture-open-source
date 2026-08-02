import { useRef } from "react";
import { motion, useInView } from "motion/react";
import { AnimatedSection } from "./AnimatedSection";
import { FilePlus, ScanLine, Send, ClipboardList, ArrowRight } from "lucide-react";

const steps = [
  {
    number: "01",
    icon: <FilePlus size={20} />,
    title: "Produire",
    desc: "Créez vos factures dans l'app : clients, lignes, TVA, conditions de paiement et toutes les mentions obligatoires.",
    color: "from-blue-600 to-indigo-600",
    glow: "rgba(59,130,246,0.3)",
  },
  {
    number: "02",
    icon: <ScanLine size={20} />,
    title: "Contrôler",
    desc: "Vérification automatique de la cohérence des données, 4 mentions obligatoires, SIREN, TVA avant toute émission.",
    color: "from-sky-600 to-cyan-500",
    glow: "rgba(14,165,233,0.3)",
  },
  {
    number: "03",
    icon: <Send size={20} />,
    title: "Transmettre",
    desc: "Via votre plateforme agréée (PA) en mode connecté, ou en export Factur‑X Pro (PDF + XML) pour dépôt manuel.",
    color: "from-violet-600 to-purple-600",
    glow: "rgba(139,92,246,0.3)",
  },
  {
    number: "04",
    icon: <ClipboardList size={20} />,
    title: "Tracer",
    desc: "Journal d'audit complet, historique des actions, exports FEC. Traçabilité totale pour vos équipes et vos commissaires.",
    color: "from-emerald-600 to-teal-500",
    glow: "rgba(16,185,129,0.3)",
  },
];

function StepCard({ step, index, total }: { step: typeof steps[0]; index: number; total: number }) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay: index * 0.15, ease: [0.22, 1, 0.36, 1] }}
      className="relative flex flex-col items-center text-center"
    >
      {/* Connector */}
      {index < total - 1 && (
        <motion.div
          className="hidden lg:flex absolute top-9 left-[calc(50%+44px)] right-[calc(-50%+44px)] items-center"
          style={{ zIndex: 0 }}
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          transition={{ delay: index * 0.15 + 0.4, duration: 0.6 }}
        >
          <motion.div
            className="flex-1 h-px"
            style={{ background: "linear-gradient(90deg, rgba(59,130,246,0.4), rgba(59,130,246,0.1))" }}
            initial={{ scaleX: 0 }}
            animate={isInView ? { scaleX: 1 } : {}}
            transition={{ duration: 0.8, delay: index * 0.15 + 0.5 }}
          />
          <motion.div
            animate={{ x: [0, 4, 0] }}
            transition={{ duration: 1.5, repeat: Infinity, delay: index * 0.5 }}
          >
            <ArrowRight size={12} className="text-blue-500 shrink-0 mx-1" />
          </motion.div>
        </motion.div>
      )}

      {/* Icon bubble */}
      <motion.div
        className={`relative w-[72px] h-[72px] rounded-2xl bg-gradient-to-br ${step.color} flex flex-col items-center justify-center mb-5 z-10`}
        style={{ boxShadow: `0 12px 40px ${step.glow}` }}
        whileHover={{ scale: 1.1, rotate: 3 }}
        transition={{ type: "spring", stiffness: 300, damping: 15 }}
      >
        <span className="text-white">{step.icon}</span>
        <span className="text-[9px] font-bold text-white/70 tracking-widest mt-0.5">{step.number}</span>
        <div className="absolute inset-0 rounded-2xl bg-white/10 opacity-0 hover:opacity-100 transition-opacity" />
      </motion.div>

      <h3 className="text-[17px] font-bold text-slate-900 mb-2">{step.title}</h3>
      <p className="text-[13px] text-slate-500 leading-[1.7] max-w-[200px]">{step.desc}</p>
    </motion.div>
  );
}

export function HowItWorks() {
  return (
    <section className="py-24 md:py-32 bg-white relative overflow-hidden">
      {/* Subtle dot grid */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.35]"
        style={{
          backgroundImage: "radial-gradient(circle, #cbd5e1 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }} />
      {/* Top fade */}
      <div className="absolute top-0 left-0 right-0 h-24 bg-gradient-to-b from-white to-transparent pointer-events-none" />
      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-white to-transparent pointer-events-none" />

      <div className="max-w-[1200px] mx-auto px-6 relative">
        <AnimatedSection className="text-center mb-20">
          <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 mb-4">
            Flux opérationnel · 4 étapes
          </span>
          <h2 className="text-[36px] md:text-[48px] font-bold text-slate-900 leading-[1.1] tracking-tight">
            Ce que fait votre équipe
          </h2>
          <p className="mt-5 text-[17px] text-slate-500 max-w-lg mx-auto leading-relaxed">
            Et ce qui est transmis via la plateforme agréée choisie — sans ambiguïté sur les rôles de chaque acteur.
          </p>
        </AnimatedSection>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-10 lg:gap-6 relative">
          {steps.map((step, i) => (
            <StepCard key={i} step={step} index={i} total={steps.length} />
          ))}
        </div>

        {/* Chain */}
        <AnimatedSection delay={0.5} className="mt-16">
          <div className="flex flex-wrap items-center justify-center gap-2 md:gap-3">
            {[
              { label: "Votre logiciel", style: { background: "#f8fafc", border: "1px solid #e2e8f0", color: "#1e293b" } },
              { arrow: true },
              { label: "Plateforme agréée (PA)", style: { background: "linear-gradient(135deg, #1d4ed8, #3b82f6)", color: "white", border: "none" } },
              { arrow: true },
              { label: "PPF / Annuaire", style: { background: "#f8fafc", border: "1px solid #e2e8f0", color: "#1e293b" } },
              { arrow: true },
              { label: "Destinataire", style: { background: "#f8fafc", border: "1px solid #e2e8f0", color: "#1e293b" } },
            ].map((item, i) => (
              item.arrow
                ? <span key={i} className="text-slate-300 text-[18px]">→</span>
                : (
                  <span key={i} className="px-4 py-2.5 rounded-xl text-[13px] font-medium shadow-sm"
                    style={item.style as React.CSSProperties}>
                    {item.label}
                  </span>
                )
            ))}
          </div>
          <p className="mx-auto mt-4 max-w-[760px] text-balance text-center text-[12px] leading-relaxed text-slate-400">
            La transmission réglementaire (e‑invoicing + e‑reporting) passe par la PA et le PPF, pas directement par le logiciel.
          </p>
        </AnimatedSection>
      </div>
    </section>
  );
}
