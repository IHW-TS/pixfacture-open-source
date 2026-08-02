"use client";
import { motion } from "motion/react";
import { Shield, Lock, Database, BadgeCheck, Server, FileText, ExternalLink } from "lucide-react";
import { getLegalConfig } from "@/lib/legalConfig";
import { AnimatedSection, AnimatedStagger, AnimatedStaggerItem } from "./AnimatedSection";
import { SecurityIllustration } from "./Illustrations";

const securityItems = [
  {
    icon: <Shield size={20} />,
    gradient: "from-blue-600 to-indigo-600",
    title: "Sécurité applicative",
    desc: "Cookies sensibles HttpOnly, protection anti-falsification, en-têtes sécurité, gestion stricte des secrets, logs RGPD minimisés.",
    glow: "rgba(59,130,246,0.2)",
  },
  {
    icon: <Lock size={20} />,
    gradient: "from-sky-600 to-cyan-500",
    title: "Auth & chiffrement",
    desc: "Authentification sécurisée avec double authentification disponible, TLS en transit, chiffrement au repos selon fournisseur et configuration. Rôles : admin, comptable, lecture.",
    glow: "rgba(14,165,233,0.2)",
  },
  {
    icon: <Server size={20} />,
    gradient: "from-emerald-600 to-teal-500",
    title: "Hébergement UE/EEE selon l'instance",
    desc: "Applicatif et bases de données dans l'UE/EEE selon instance. Sauvegardes, monitoring, RPO/RTO selon config.",
    glow: "rgba(16,185,129,0.2)",
  },
  {
    icon: <BadgeCheck size={20} />,
    gradient: "from-amber-500 to-orange-500",
    title: "RGPD & DPA",
    desc: "Accord de traitement (DPA) disponible. Droit à l'oubli et export dans les limites des obligations légales de conservation.",
    glow: "rgba(245,158,11,0.2)",
  },
  {
    icon: <Database size={20} />,
    gradient: "from-violet-600 to-purple-600",
    title: "Archivage renforcé",
    desc: "S3 compatible, Object Lock si activé, rétention paramétrable. Réversibilité PDF/CSV et artefacts Factur‑X lorsqu'ils existent.",
    glow: "rgba(139,92,246,0.2)",
  },
  {
    icon: <FileText size={20} />,
    gradient: "from-slate-500 to-slate-600",
    title: "Support & SLA",
    desc: "Support public par email, pages légales visibles avant souscription, et SLA dédié uniquement sur contrat Volume.",
    glow: "rgba(100,116,139,0.2)",
  },
];

const trustBadges = [
  { label: "TLS 1.2+", sub: "TLS 1.3 si disponible" },
  { label: "Config", sub: "Chiffrement repos" },
  { label: "UE/EEE", sub: "Selon instance" },
  { label: "RGPD", sub: "DPA disponible" },
  { label: "6 ans", sub: "Archivage fiscal" },
  { label: "Double auth.", sub: "Code sécurisé" },
];

export function Security() {
  const { supportEmail } = getLegalConfig();
  const trustLinks = [
    { label: "Page sécurité", href: "/security" },
    { label: "Voir le DPA", href: "/legal/dpa" },
    { label: "Voir les CGU", href: "/legal/terms" },
    { label: "Centre confiance", href: "/confiance" },
    { label: "Support public", href: `mailto:${supportEmail}` },
  ];

  return (
    <section
      id="security"
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
      {/* Radial accent */}
      <div
        className="absolute top-0 right-0 w-[600px] h-[600px] pointer-events-none"
        style={{ background: "radial-gradient(circle at 80% 10%, rgba(59,130,246,0.06) 0%, transparent 65%)" }}
      />

      <div className="max-w-[1240px] mx-auto px-6 md:px-8 relative">
        {/* Header */}
        <div className="grid lg:grid-cols-2 gap-14 items-start mb-20">
          <AnimatedSection className="flex flex-col items-center text-center lg:items-start lg:text-left">
            <div className="flex max-w-[760px] flex-col gap-6">
              <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] leading-none text-blue-300">
                Centre de confiance
              </span>
              <h2
                aria-label="Sécurité professionnelle par défaut"
                className="max-w-[760px] text-4xl md:text-5xl font-bold text-white leading-[1.08] tracking-tight"
              >
                Sécurité{" "}
                <span
                  style={{
                    background: "linear-gradient(90deg, #60a5fa, #818cf8)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                  }}
                >
                  professionnelle
                </span>{" "}
                par défaut
              </h2>
              <p className="max-w-[760px] text-[17px] leading-relaxed" style={{ color: "rgba(203,213,225,0.9)" }}>
                Auth, chiffrement, sauvegardes, monitoring, logs sécurisés, hébergement UE/EEE et support public
                visible. Les garanties utiles avant une mise en production, selon votre configuration.
              </p>
            </div>

            {/* Trust badges */}
            <div className="mt-6 flex flex-wrap justify-center gap-3 lg:justify-start">
              {trustBadges.map((b, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, scale: 0.9 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.08 }}
                  className="flex flex-col items-center px-4 py-3 rounded-xl"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
                  whileHover={{ background: "rgba(255,255,255,0.07)", borderColor: "rgba(59,130,246,0.3)" }}
                >
                  <span className="text-[15px] font-bold text-white">{b.label}</span>
                  <span className="text-[10px] mt-0.5" style={{ color: "rgba(148,163,184,0.8)" }}>
                    {b.sub}
                  </span>
                </motion.div>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap justify-center gap-4 lg:justify-start">
              {trustLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="inline-flex items-center gap-1 text-[13px] font-medium text-blue-300 hover:text-blue-200 transition-colors"
                >
                  {link.label} <ExternalLink size={11} />
                </a>
              ))}
            </div>
          </AnimatedSection>

          {/* Illustration */}
          <AnimatedSection direction="right" delay={0.2}>
            <div
              className="rounded-2xl overflow-hidden aspect-[4/3] relative"
              style={{ border: "1px solid rgba(255,255,255,0.06)", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}
            >
              <SecurityIllustration />
            </div>
          </AnimatedSection>
        </div>

        {/* Grid */}
        <AnimatedStagger className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {securityItems.map((item, i) => (
            <AnimatedStaggerItem key={i}>
              <motion.div
                className="rounded-2xl p-6 flex gap-4 items-start"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
                whileHover={{
                  background: "rgba(255,255,255,0.05)",
                  borderColor: item.glow,
                  y: -3,
                  boxShadow: `0 16px 40px rgba(0,0,0,0.3), 0 0 20px ${item.glow}`,
                }}
                transition={{ type: "spring", stiffness: 280, damping: 22 }}
              >
                <div
                  className={`w-10 h-10 rounded-xl bg-gradient-to-br ${item.gradient} flex items-center justify-center shrink-0 text-white shadow-lg`}
                >
                  {item.icon}
                </div>
                <div>
                  <h3 className="text-[14px] font-semibold text-white mb-1.5">{item.title}</h3>
                  <p className="text-[13px] leading-[1.65]" style={{ color: "rgba(203,213,225,0.82)" }}>
                    {item.desc}
                  </p>
                </div>
              </motion.div>
            </AnimatedStaggerItem>
          ))}
        </AnimatedStagger>
      </div>
    </section>
  );
}
