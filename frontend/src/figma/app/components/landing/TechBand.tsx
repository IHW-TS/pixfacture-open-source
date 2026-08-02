"use client";
import { motion } from "motion/react";
import { AnimatedSection } from "./AnimatedSection";

const techs = [
  {
    name: "Factur‑X",
    desc: "XML/CII selon configuration",
    color: "#3b82f6",
    bg: "rgba(59,130,246,0.08)",
    border: "rgba(59,130,246,0.2)",
    dot: "#3b82f6",
  },
  {
    name: "UBL 2.1",
    desc: "Universal Business Language",
    color: "#8b5cf6",
    bg: "rgba(139,92,246,0.08)",
    border: "rgba(139,92,246,0.2)",
    dot: "#8b5cf6",
  },
  {
    name: "EN 16931",
    desc: "Norme européenne CII",
    color: "#0ea5e9",
    bg: "rgba(14,165,233,0.08)",
    border: "rgba(14,165,233,0.2)",
    dot: "#0ea5e9",
  },
  {
    name: "B2G",
    desc: "PISTE · B2G · Marchés publics",
    color: "#f59e0b",
    bg: "rgba(245,158,11,0.08)",
    border: "rgba(245,158,11,0.2)",
    dot: "#f59e0b",
  },
  {
    name: "Cloud UE/EEE",
    desc: "UE/EEE selon instance",
    color: "#10b981",
    bg: "rgba(16,185,129,0.08)",
    border: "rgba(16,185,129,0.2)",
    dot: "#10b981",
  },
  {
    name: "RGPD · DPA",
    desc: "Accord de traitement inclus",
    color: "#f43f5e",
    bg: "rgba(244,63,94,0.08)",
    border: "rgba(244,63,94,0.2)",
    dot: "#f43f5e",
  },
];

export function TechBand() {
  return (
    <section
      className="py-12 md:py-16 bg-white"
      style={{ borderTop: "1px solid #f1f5f9", borderBottom: "1px solid #f1f5f9" }}
    >
      <div className="max-w-[1200px] mx-auto px-6">
        <AnimatedSection className="text-center mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-700">
            Standards & compatibilité
          </p>
        </AnimatedSection>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {techs.map((tech, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.07, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            >
              <motion.div
                className="relative rounded-2xl p-4 flex flex-col gap-2 overflow-hidden cursor-default"
                style={{
                  background: tech.bg,
                  border: `1px solid ${tech.border}`,
                }}
                whileHover={{
                  y: -3,
                  boxShadow: `0 12px 32px rgba(0,0,0,0.08), 0 0 0 1px ${tech.border}`,
                  background: tech.bg.replace("0.08", "0.14"),
                }}
                transition={{ type: "spring", stiffness: 350, damping: 22 }}
              >
                {/* Animated dot */}
                <div className="flex items-center gap-1.5 mb-1">
                  <motion.div
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: tech.dot }}
                    animate={{ opacity: [1, 0.4, 1] }}
                    transition={{ duration: 2 + i * 0.3, repeat: Infinity, delay: i * 0.2 }}
                  />
                  <span className="text-[11px] font-bold tracking-tight" style={{ color: tech.color }}>
                    {tech.name}
                  </span>
                </div>
                <p className="text-[10px] leading-[1.5]" style={{ color: "rgba(71,85,105,0.92)" }}>
                  {tech.desc}
                </p>
              </motion.div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
