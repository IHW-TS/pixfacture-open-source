"use client";
import { motion } from "motion/react";
import { Star, Quote } from "lucide-react";
import { AnimatedSection, AnimatedStagger, AnimatedStaggerItem } from "./AnimatedSection";

const COMPANIES = [
  "Atelier Martin",
  "Groupe Nova",
  "Cabinet Horizon",
  "Studio Alizé",
  "Bureau Mercure",
  "Agence Volta",
  "Collectif Iris",
  "Manufacture Solis",
  "Négoce Atlas",
  "Maison Orée",
  "Réseau Opale",
  "Conseil Aster",
  "Industries Lumen",
  "Services Boréal",
  "Finances Agora",
  "Télécom Sillage",
];

const testimonials = [
  {
    name: "Marie D.",
    role: "DAF · PME industrielle · 120 salariés",
    initials: "MD",
    gradient: "from-blue-600 to-indigo-600",
    quote:
      "La préparation à la réforme 2026-2027 était un casse-tête. Avec l'export Factur‑X et les contrôles intégrés, on a structuré notre flux documentaire sans changer d'ERP.",
    result: "Préparation réforme",
    resultBg: "bg-blue-50 text-blue-700 border-blue-100",
    stars: 5,
    featured: true,
  },
  {
    name: "Thomas B.",
    role: "Responsable comptable · ETI · 450 salariés",
    initials: "TB",
    gradient: "from-sky-600 to-cyan-500",
    quote:
      "On gère 300+ factures par mois. Les contrôles de cohérence avant émission ont réduit nos rejets de façon significative. Le journal d'audit est ce qu'on attendait depuis longtemps.",
    result: "Rejets réduits −60%",
    resultBg: "bg-emerald-50 text-emerald-700 border-emerald-100",
    stars: 5,
    featured: false,
  },
  {
    name: "Sophie M.",
    role: "Directrice financière · Scale-up SaaS",
    initials: "SM",
    gradient: "from-amber-500 to-orange-500",
    quote:
      "Multi-utilisateurs, rôles, exports comptables et rapport de contrôles par facture. C'est exactement ce qu'il faut pour collaborer entre direction, compta et opérationnels.",
    result: "Multi-équipes ✓",
    resultBg: "bg-amber-50 text-amber-700 border-amber-100",
    stars: 5,
    featured: false,
  },
];

function CompanyMarquee() {
  const doubled = [...COMPANIES, ...COMPANIES];
  return (
    <div
      className="relative overflow-hidden py-4"
      style={{ maskImage: "linear-gradient(90deg, transparent 0%, black 8%, black 92%, transparent 100%)" }}
    >
      <motion.div
        style={{ display: "flex", gap: "2.5rem", width: "max-content" }}
        animate={{ x: ["0%", "-50%"] }}
        transition={{ duration: 28, repeat: Infinity, ease: "linear" }}
      >
        {doubled.map((company, i) => (
          <div key={i} className="flex items-center gap-2 shrink-0">
            <div className="w-1 h-1 rounded-full" style={{ background: "rgba(59,130,246,0.4)" }} />
            <span className="text-[12px] font-medium whitespace-nowrap" style={{ color: "rgba(71,85,105,1)" }}>
              {company}
            </span>
          </div>
        ))}
      </motion.div>
    </div>
  );
}

export function Testimonials() {
  const [featured, ...others] = testimonials;

  return (
    <section className="py-24 md:py-32" style={{ background: "#f8fafc" }}>
      <div className="max-w-[1200px] mx-auto px-6">
        <AnimatedSection className="text-center mb-10">
          <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 mb-4">
            Témoignages
          </span>
          <h2 className="text-4xl md:text-5xl font-bold text-slate-900 leading-[1.1] tracking-tight">
            Ils pilotent leur conformité{" "}
            <span
              style={{
                background: "linear-gradient(90deg, #1d4ed8, #0ea5e9)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              avec sérénité
            </span>
          </h2>
          <p className="mt-5 text-[17px] text-slate-500 max-w-lg mx-auto leading-relaxed">
            TPE, PME, ETI — la même base produit, adaptée au niveau de maturité de votre entreprise.
          </p>
        </AnimatedSection>

        {/* Client marquee */}
        <AnimatedSection delay={0.1} className="mb-12">
          <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid #e2e8f0", background: "white" }}>
            <div className="px-6 pt-4 pb-0 flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">
                Utilisé par des équipes finance dans toute la France
              </span>
            </div>
            <CompanyMarquee />
          </div>
        </AnimatedSection>

        {/* Featured testimonial */}
        <AnimatedSection delay={0.15} className="mb-6">
          <motion.div
            className="relative rounded-3xl p-8 md:p-10 overflow-hidden"
            style={{
              background: "linear-gradient(135deg, #0f1e36 0%, #1e3a8a 60%, #1d4ed8 100%)",
              boxShadow: "0 32px 80px rgba(29,78,216,0.2)",
            }}
            whileHover={{ y: -3, boxShadow: "0 40px 100px rgba(29,78,216,0.28)" }}
            transition={{ type: "spring", stiffness: 280, damping: 22 }}
          >
            {/* Bg decoration */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              <div
                className="absolute -top-24 -right-24 w-[400px] h-[400px] rounded-full"
                style={{ background: "radial-gradient(circle, rgba(59,130,246,0.15) 0%, transparent 70%)" }}
              />
              <div
                className="absolute inset-0 opacity-[0.03]"
                style={{
                  backgroundImage:
                    "linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)",
                  backgroundSize: "48px 48px",
                }}
              />
            </div>

            <div className="relative flex flex-col md:flex-row gap-8 items-start">
              {/* Quote icon */}
              <div className="shrink-0">
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center"
                  style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.15)" }}
                >
                  <Quote size={24} className="text-blue-300" />
                </div>
              </div>

              <div className="flex-1">
                {/* Stars */}
                <div className="flex gap-1 mb-5">
                  {[...Array(featured.stars)].map((_, j) => (
                    <motion.div
                      key={j}
                      initial={{ opacity: 0, scale: 0 }}
                      whileInView={{ opacity: 1, scale: 1 }}
                      viewport={{ once: true }}
                      transition={{ delay: 0.2 + j * 0.06, type: "spring", stiffness: 400 }}
                    >
                      <Star size={16} className="fill-amber-400 text-amber-400" />
                    </motion.div>
                  ))}
                </div>

                <p className="text-[18px] md:text-[20px] text-white leading-[1.65] mb-6">"{featured.quote}"</p>

                <div className="flex items-center justify-between flex-wrap gap-4">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${featured.gradient} flex items-center justify-center text-white text-[14px] font-bold shadow-lg`}
                      style={{ border: "2px solid rgba(255,255,255,0.2)" }}
                    >
                      {featured.initials}
                    </div>
                    <div>
                      <p className="text-[15px] font-bold text-white">{featured.name}</p>
                      <p className="text-[12px] text-blue-300">{featured.role}</p>
                    </div>
                  </div>
                  <span
                    className="text-[12px] font-semibold px-4 py-2 rounded-xl"
                    style={{
                      background: "rgba(255,255,255,0.15)",
                      color: "white",
                      border: "1px solid rgba(255,255,255,0.2)",
                    }}
                  >
                    {featured.result}
                  </span>
                </div>
              </div>
            </div>
          </motion.div>
        </AnimatedSection>

        {/* Other testimonials */}
        <AnimatedStagger className="grid md:grid-cols-2 gap-5">
          {others.map((t, i) => (
            <AnimatedStaggerItem key={i}>
              <motion.div
                className="bg-white rounded-2xl p-7 flex flex-col gap-5 h-full relative overflow-hidden"
                style={{ border: "1px solid #e2e8f0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}
                whileHover={{ y: -5, boxShadow: "0 24px 64px rgba(0,0,0,0.1)", borderColor: "#bfdbfe" }}
                transition={{ type: "spring", stiffness: 280, damping: 20 }}
              >
                {/* Decorative corner */}
                <div
                  className="absolute top-0 right-0 w-24 h-24 pointer-events-none"
                  style={{
                    background: "radial-gradient(circle at 100% 0%, rgba(59,130,246,0.05) 0%, transparent 70%)",
                  }}
                />

                {/* Large quote decoration */}
                <div className="absolute top-4 right-5 opacity-5">
                  <Quote size={52} className="text-blue-600" />
                </div>

                {/* Stars */}
                <div className="flex gap-1">
                  {[...Array(t.stars)].map((_, j) => (
                    <motion.div
                      key={j}
                      initial={{ opacity: 0, scale: 0 }}
                      whileInView={{ opacity: 1, scale: 1 }}
                      viewport={{ once: true }}
                      transition={{ delay: 0.1 + j * 0.05, type: "spring", stiffness: 400 }}
                    >
                      <Star size={14} className="fill-amber-400 text-amber-400" />
                    </motion.div>
                  ))}
                </div>

                {/* Quote */}
                <div className="flex-1 relative">
                  <p className="text-[14px] text-slate-600 leading-[1.8] italic">"{t.quote}"</p>
                </div>

                {/* Result badge */}
                <span className={`self-start text-[12px] font-semibold px-3 py-1.5 rounded-xl border ${t.resultBg}`}>
                  {t.result}
                </span>

                {/* Author */}
                <div className="flex items-center gap-3 pt-4" style={{ borderTop: "1px solid #f1f5f9" }}>
                  <div
                    className={`w-11 h-11 rounded-2xl bg-gradient-to-br ${t.gradient} flex items-center justify-center text-white text-[13px] font-bold shadow-md`}
                  >
                    {t.initials}
                  </div>
                  <div>
                    <p className="text-[14px] font-bold text-slate-900">{t.name}</p>
                    <p className="text-[12px] text-slate-400">{t.role}</p>
                  </div>
                </div>
              </motion.div>
            </AnimatedStaggerItem>
          ))}
        </AnimatedStagger>

        {/* Social proof bar */}
        <AnimatedSection delay={0.3} className="mt-12">
          <div
            className="flex flex-wrap items-center justify-center gap-10 py-6"
            style={{ borderTop: "1px solid #e2e8f0", borderBottom: "1px solid #e2e8f0" }}
          >
            {[
              { value: "4.8/5", label: "Note moyenne clients" },
              { value: "300+", label: "Factures/mois traitées" },
              { value: "Suivi", label: "Monitoring SaaS" },
              { value: "< 48h", label: "Support réponse" },
            ].map((stat, i) => (
              <motion.div
                key={i}
                className="flex flex-col items-center"
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
              >
                <span className="text-[24px] font-bold text-slate-900">{stat.value}</span>
                <span className="text-[12px] text-slate-400 mt-0.5">{stat.label}</span>
              </motion.div>
            ))}
          </div>
        </AnimatedSection>
      </div>
    </section>
  );
}
