import { motion } from "motion/react";
import { Shield, Lock, Database, BadgeCheck, Server, FileText, ExternalLink } from "lucide-react";
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
    desc: "Authentification sécurisée avec double authentification disponible, TLS en transit, chiffrement au repos. Rôles : admin, comptable, lecture.",
    glow: "rgba(14,165,233,0.2)",
  },
  {
    icon: <Server size={20} />,
    gradient: "from-emerald-600 to-teal-500",
    title: "Hébergement UE/EEE",
    desc: "Applicatif et bases de données dans l'UE/EEE selon instance. Sauvegardes, monitoring, RPO/RTO selon config.",
    glow: "rgba(16,185,129,0.2)",
  },
  {
    icon: <BadgeCheck size={20} />,
    gradient: "from-amber-500 to-orange-500",
    title: "RGPD & DPA",
    desc: "Accord de traitement (DPA) disponible. Droit à l'oubli, export à tout moment, sous-traitants documentés.",
    glow: "rgba(245,158,11,0.2)",
  },
  {
    icon: <Database size={20} />,
    gradient: "from-violet-600 to-purple-600",
    title: "Archivage renforcé",
    desc: "S3 compatible, Object Lock si activé, rétention paramétrable. Export Factur‑X/PDF/CSV pour réversibilité.",
    glow: "rgba(139,92,246,0.2)",
  },
  {
    icon: <FileText size={20} />,
    gradient: "from-slate-500 to-slate-600",
    title: "Support & SLA",
    desc: "Maintenance et modalités documentées. Monitoring configurable. CGU pour le détail des engagements.",
    glow: "rgba(100,116,139,0.2)",
  },
];

const trustBadges = [
  { label: "TLS 1.3", sub: "Chiffrement transit" },
  { label: "AES-256", sub: "Chiffrement repos" },
  { label: "France", sub: "Hébergement UE" },
  { label: "RGPD", sub: "DPA disponible" },
  { label: "6 ans", sub: "Archivage fiscal" },
  { label: "Double auth.", sub: "Code sécurisé" },
];

export function Security() {
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

      <div className="max-w-[1200px] mx-auto px-6 relative">
        {/* Header */}
        <div className="grid lg:grid-cols-2 gap-14 items-start mb-20">
          <AnimatedSection>
            <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-400 mb-4">
              Centre de confiance
            </span>
            <h2 className="text-[36px] md:text-[48px] font-bold text-white leading-[1.1] tracking-tight">
              Sécurité{" "}
              <span
                style={{
                  background: "linear-gradient(90deg, #60a5fa, #818cf8)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}
              >
                enterprise
              </span>{" "}
              par défaut
            </h2>
            <p className="mt-5 text-[17px] leading-[1.75] max-w-lg" style={{ color: "rgba(148,163,184,1)" }}>
              Auth, chiffrement, sauvegardes, monitoring, logs sécurisés, hébergement France. Tout ce qu'exige une
              production sérieuse.
            </p>

            {/* Trust badges */}
            <div className="flex flex-wrap gap-3 mt-8">
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
                  <span className="text-[10px] mt-0.5" style={{ color: "rgba(71,85,105,1)" }}>
                    {b.sub}
                  </span>
                </motion.div>
              ))}
            </div>

            <div className="flex flex-wrap gap-4 mt-8">
              {[
                { label: "Page sécurité", href: "/security" },
                { label: "Voir le DPA", href: "/legal/dpa" },
                { label: "Voir les CGU", href: "/legal/terms" },
                { label: "Centre confiance", href: "/confiance" },
              ].map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="inline-flex items-center gap-1 text-[13px] font-medium text-blue-400 hover:text-blue-300 transition-colors"
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
                  <p className="text-[13px] leading-[1.65]" style={{ color: "rgba(100,116,139,1)" }}>
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
