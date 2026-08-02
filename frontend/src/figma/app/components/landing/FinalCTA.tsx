"use client";
import { motion } from "motion/react";
import { ArrowRight, Shield, Zap, Users, CheckCircle2, TrendingUp, FileCheck, Lock } from "lucide-react";
import { AnimatedSection } from "./AnimatedSection";

const features = [
  { icon: <Shield size={14} />, text: "Hébergement UE/EEE selon l'instance" },
  { icon: <Zap size={14} />, text: "Factur‑X Pro après contrôles requis" },
  { icon: <Users size={14} />, text: "Multi-utilisateurs avec Pro" },
  { icon: <CheckCircle2 size={14} />, text: "Résiliable avant la prochaine échéance" },
];

const floatingCards = [
  {
    id: "left-1",
    position: "absolute left-4 top-[20%] hidden xl:block",
    icon: <TrendingUp size={15} className="text-emerald-400" />,
    iconBg: "rgba(16,185,129,0.15)",
    iconBorder: "rgba(16,185,129,0.25)",
    label: "Conformité",
    value: "Contrôles",
    sub: "Selon configuration",
    animY: [0, -8, 0],
    delay: 0,
    dur: 4.2,
  },
  {
    id: "left-2",
    position: "absolute left-4 top-[60%] hidden xl:block",
    icon: <FileCheck size={15} className="text-blue-400" />,
    iconBg: "rgba(59,130,246,0.15)",
    iconBorder: "rgba(59,130,246,0.25)",
    label: "Validations Factur‑X Pro",
    value: "Actives",
    sub: "Si facture conforme",
    animY: [0, 8, 0],
    delay: 1.2,
    dur: 5,
  },
  {
    id: "right-1",
    position: "absolute right-4 top-[25%] hidden xl:block",
    icon: <Lock size={15} className="text-violet-400" />,
    iconBg: "rgba(139,92,246,0.15)",
    iconBorder: "rgba(139,92,246,0.25)",
    label: "Archivage sécurisé",
    value: "Configurable",
    sub: "Rétention selon option",
    animY: [0, -6, 0],
    delay: 0.7,
    dur: 4.6,
  },
  {
    id: "right-2",
    position: "absolute right-4 top-[58%] hidden xl:block",
    icon: <Zap size={15} className="text-amber-400" />,
    iconBg: "rgba(245,158,11,0.15)",
    iconBorder: "rgba(245,158,11,0.25)",
    label: "Délai d'émission",
    value: "Variable",
    sub: "Selon pièces et validation",
    animY: [0, 6, 0],
    delay: 1.8,
    dur: 3.8,
  },
];

export function FinalCTA() {
  return (
    <section className="py-16 md:py-24 bg-white relative">
      {/* Floating metric cards */}
      {floatingCards.map((card) => (
        <motion.div
          key={card.id}
          className={card.position}
          initial={{ opacity: 0, scale: 0.9 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          transition={{ delay: card.delay + 0.5, duration: 0.6 }}
          animate={{ y: card.animY }}
          style={{ animationDelay: `${card.delay}s` }}
        >
          <motion.div
            animate={{ y: card.animY }}
            transition={{ duration: card.dur, repeat: Infinity, ease: "easeInOut", delay: card.delay }}
            className="px-4 py-3.5 rounded-2xl min-w-[160px]"
            style={{
              background: "white",
              border: "1px solid #e2e8f0",
              boxShadow: "0 12px 40px rgba(0,0,0,0.08)",
            }}
            whileHover={{ y: -3, boxShadow: "0 20px 56px rgba(0,0,0,0.12)" }}
          >
            <div className="flex items-center gap-2 mb-2">
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: card.iconBg, border: `1px solid ${card.iconBorder}` }}
              >
                {card.icon}
              </div>
              <span className="text-[11px] font-medium text-slate-400">{card.label}</span>
            </div>
            <p className="text-[20px] font-bold text-slate-900 leading-none mb-1">{card.value}</p>
            <p className="text-[11px] text-slate-400">{card.sub}</p>
          </motion.div>
        </motion.div>
      ))}

      <div className="max-w-[1200px] mx-auto px-6">
        <AnimatedSection>
          <motion.div
            className="relative rounded-3xl overflow-hidden"
            style={{
              background: "linear-gradient(135deg, #060e1e 0%, #0f1e36 30%, #1e3a8a 65%, #1d4ed8 100%)",
            }}
            whileHover={{ scale: 1.003 }}
            transition={{ type: "spring", stiffness: 200, damping: 30 }}
          >
            {/* Decorative elements */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              <motion.div
                className="absolute -top-32 -right-32 w-[600px] h-[600px] rounded-full"
                style={{ background: "radial-gradient(circle, rgba(59,130,246,0.12) 0%, transparent 65%)" }}
                animate={{ scale: [1, 1.1, 1], rotate: [0, 15, 0] }}
                transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
              />
              <motion.div
                className="absolute -bottom-32 -left-16 w-[500px] h-[500px] rounded-full"
                style={{ background: "radial-gradient(circle, rgba(129,140,248,0.1) 0%, transparent 65%)" }}
                animate={{ scale: [1.1, 1, 1.1], rotate: [0, -10, 0] }}
                transition={{ duration: 10, repeat: Infinity, ease: "easeInOut", delay: 2 }}
              />
              {/* Grid */}
              <div
                className="absolute inset-0 opacity-[0.04]"
                style={{
                  backgroundImage:
                    "linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)",
                  backgroundSize: "56px 56px",
                }}
              />
              {/* Top line */}
              <div
                className="absolute top-0 left-0 right-0 h-px"
                style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent)" }}
              />
              {/* Bottom glow */}
              <div
                className="absolute bottom-0 left-0 right-0 h-[200px]"
                style={{ background: "linear-gradient(0deg, rgba(29,78,216,0.2) 0%, transparent 100%)" }}
              />
            </div>

            <div className="relative z-10 px-8 md:px-16 py-16 md:py-20">
              <div className="max-w-2xl mx-auto text-center">
                {/* Trust badge */}
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  className="inline-flex items-center gap-2 mb-8 px-4 py-2 rounded-full"
                  style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)" }}
                >
                  <Shield size={13} className="text-blue-300" />
                  <span className="text-[12px] font-medium text-blue-200">
                    Hébergement UE/EEE selon l'instance · TLS en transit · RGPD
                  </span>
                </motion.div>

                {/* Headline */}
                <motion.h2
                  aria-label="Prêt à moderniser votre parcours de facturation ?"
                  initial={{ opacity: 0, y: 24 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.7 }}
                  className="text-[32px] md:text-[44px] font-bold text-white leading-[1.1] tracking-tight mb-5"
                >
                  Prêt à moderniser votre{" "}
                  <span
                    style={{
                      background: "linear-gradient(90deg, #93c5fd, #c4b5fd)",
                      WebkitBackgroundClip: "text",
                      WebkitTextFillColor: "transparent",
                      backgroundClip: "text",
                    }}
                  >
                    parcours de facturation ?
                  </span>
                </motion.h2>

                <motion.p
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.2, duration: 0.6 }}
                  className="text-[16px] leading-[1.75] mb-10"
                  style={{ color: "rgba(147,197,253,0.85)" }}
                >
                  Démarrez avec la facturation PDF, puis activez les exports Pro. Le mode connecté exige un contrat, un
                  mandat et un connecteur configuré auprès de votre plateforme agréée.
                </motion.p>

                {/* CTAs */}
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.3, duration: 0.6 }}
                  className="flex flex-col sm:flex-row gap-3 justify-center mb-10"
                >
                  <motion.a
                    href="/app/register?plan=pro"
                    className="inline-flex items-center justify-center gap-2 rounded-2xl border-none bg-white px-7 py-4 text-[15px] font-bold text-blue-700 shadow-[0_14px_30px_rgba(255,255,255,0.18)]"
                    whileHover={{ scale: 1.04, boxShadow: "0 16px 40px rgba(255,255,255,0.2)" }}
                    whileTap={{ scale: 0.97 }}
                  >
                    Essayer gratuitement <ArrowRight size={16} />
                  </motion.a>
                  <motion.a
                    href="/pricing"
                    className="inline-flex items-center justify-center gap-2 px-7 py-4 rounded-2xl text-[15px] font-semibold cursor-pointer transition-all"
                    style={{
                      background: "rgba(255,255,255,0.12)",
                      border: "1px solid rgba(255,255,255,0.24)",
                      color: "white",
                    }}
                    whileHover={{ background: "rgba(255,255,255,0.18)" }}
                    whileTap={{ scale: 0.97 }}
                  >
                    Voir les tarifs
                  </motion.a>
                </motion.div>

                {/* Feature pills */}
                <motion.div
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.45 }}
                  className="flex flex-wrap justify-center gap-3 mb-6"
                >
                  {features.map((f, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-full"
                      style={{ background: "rgba(255,255,255,0.08)", color: "rgba(147,197,253,0.9)" }}
                    >
                      <span className="text-blue-300">{f.icon}</span>
                      {f.text}
                    </span>
                  ))}
                </motion.div>

                <motion.p
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.55 }}
                  className="text-[11px]"
                  style={{ color: "rgba(59,130,246,0.5)" }}
                >
                  Le service ne constitue pas un conseil fiscal/juridique.
                </motion.p>
              </div>
            </div>
          </motion.div>
        </AnimatedSection>
      </div>
    </section>
  );
}
