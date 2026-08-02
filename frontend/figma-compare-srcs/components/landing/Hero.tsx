import { motion } from "motion/react";
import { ArrowRight, FileCheck, TrendingUp, CheckCircle } from "lucide-react";
import { Link } from "react-router";
import { useEffect, useRef, useState } from "react";

function AnimatedCounter({
  from,
  to,
  suffix = "",
  duration = 2,
}: {
  from: number;
  to: number;
  suffix?: string;
  duration?: number;
}) {
  const [display, setDisplay] = useState(from);
  const hasAnimated = useRef(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !hasAnimated.current) {
        hasAnimated.current = true;
        let start = from;
        const step = (to - from) / (duration * 60);
        const timer = setInterval(() => {
          start += step;
          if (start >= to) {
            setDisplay(to);
            clearInterval(timer);
          } else setDisplay(Math.round(start));
        }, 1000 / 60);
      }
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [from, to, duration]);

  return (
    <span ref={ref}>
      {display}
      {suffix}
    </span>
  );
}

const invoiceRows = [
  {
    id: "FX-2847",
    client: "Atelier Martin",
    amount: "€12,450",
    status: "sent",
    statusLabel: "Préparé",
    color: "text-emerald-400",
  },
  {
    id: "FX-2848",
    client: "Groupe Nova",
    amount: "€8,200",
    status: "pending",
    statusLabel: "En attente",
    color: "text-amber-400",
  },
  {
    id: "FX-2849",
    client: "Cabinet Horizon",
    amount: "€31,800",
    status: "sent",
    statusLabel: "Préparé",
    color: "text-emerald-400",
  },
  {
    id: "FX-2850",
    client: "Studio Alizé",
    amount: "€5,640",
    status: "check",
    statusLabel: "Contrôle ✓",
    color: "text-blue-400",
  },
];

const PARTICLES = [
  { x: 78, y: 8, size: 2, opacity: 0.25, dur: 14, delay: 0 },
  { x: 90, y: 25, size: 1.5, opacity: 0.18, dur: 18, delay: 1.2 },
  { x: 65, y: 42, size: 2.5, opacity: 0.12, dur: 12, delay: 0.5 },
  { x: 94, y: 58, size: 1, opacity: 0.16, dur: 20, delay: 3 },
  { x: 72, y: 80, size: 2, opacity: 0.12, dur: 16, delay: 1.8 },
  { x: 58, y: 12, size: 1.5, opacity: 0.14, dur: 22, delay: 2.4 },
  { x: 97, y: 38, size: 1.5, opacity: 0.1, dur: 15, delay: 0.8 },
  { x: 62, y: 95, size: 2, opacity: 0.08, dur: 13, delay: 4 },
  { x: 55, y: 68, size: 1.5, opacity: 0.12, dur: 17, delay: 1.5 },
  { x: 85, y: 50, size: 3, opacity: 0.07, dur: 19, delay: 2.8 },
  { x: 8, y: 15, size: 1.5, opacity: 0.07, dur: 16, delay: 1 },
  { x: 18, y: 72, size: 1, opacity: 0.05, dur: 21, delay: 3.5 },
  { x: 4, y: 50, size: 2, opacity: 0.07, dur: 14, delay: 0.3 },
  { x: 32, y: 88, size: 1.5, opacity: 0.05, dur: 18, delay: 2 },
  { x: 42, y: 28, size: 1, opacity: 0.07, dur: 23, delay: 4.5 },
  { x: 25, y: 45, size: 2, opacity: 0.05, dur: 11, delay: 1.7 },
  { x: 50, y: 5, size: 1, opacity: 0.1, dur: 24, delay: 3.2 },
  { x: 74, y: 62, size: 1.5, opacity: 0.09, dur: 20, delay: 5 },
];

export function Hero() {
  return (
    <section
      id="hero"
      className="relative min-h-screen flex items-center overflow-hidden"
      style={{ background: "linear-gradient(160deg, #070d1a 0%, #0d1f3c 45%, #0f2244 100%)" }}
    >
      {/* Animated mesh background */}
      <div className="absolute inset-0 pointer-events-none">
        <motion.div
          className="absolute top-0 right-0 w-[900px] h-[900px] rounded-full opacity-20"
          style={{ background: "radial-gradient(circle at 60% 40%, #1d4ed8 0%, transparent 65%)" }}
          animate={{ scale: [1, 1.08, 1], opacity: [0.15, 0.22, 0.15] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute bottom-0 left-0 w-[700px] h-[700px] rounded-full opacity-10"
          style={{ background: "radial-gradient(circle at 40% 60%, #0ea5e9 0%, transparent 65%)" }}
          animate={{ scale: [1.05, 1, 1.05], opacity: [0.08, 0.14, 0.08] }}
          transition={{ duration: 10, repeat: Infinity, ease: "easeInOut", delay: 2 }}
        />
        {/* Grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)",
            backgroundSize: "72px 72px",
          }}
        />
        {/* Top glow line */}
        <div
          className="absolute top-0 left-0 right-0 h-px"
          style={{ background: "linear-gradient(90deg, transparent, rgba(59,130,246,0.4), transparent)" }}
        />

        {/* Noise texture */}
        <div
          className="absolute inset-0 opacity-[0.03] pointer-events-none"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
            backgroundSize: "180px 180px",
          }}
        />

        {/* Floating particles */}
        {PARTICLES.map((p, i) => (
          <motion.div
            key={i}
            className="absolute rounded-full"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: p.size,
              height: p.size,
              opacity: p.opacity,
              background: i % 3 === 0 ? "#60a5fa" : i % 3 === 1 ? "#818cf8" : "#a78bfa",
            }}
            animate={{
              y: [0, -(12 + (i % 4) * 4), 0],
              opacity: [p.opacity, p.opacity * 2.2, p.opacity],
            }}
            transition={{ duration: p.dur, repeat: Infinity, ease: "easeInOut", delay: p.delay }}
          />
        ))}
      </div>

      <div className="relative max-w-[1200px] mx-auto px-6 pt-28 pb-16 w-full">
        <div className="grid lg:grid-cols-2 gap-14 lg:gap-20 items-center">
          {/* Left: Text */}
          <div className="flex flex-col gap-7">
            {/* Badge */}
            <motion.div
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
            >
              <span
                className="inline-flex items-center gap-2.5 border px-4 py-2 rounded-full text-[12px] font-medium"
                style={{ borderColor: "rgba(59,130,246,0.35)", background: "rgba(29,78,216,0.12)", color: "#93c5fd" }}
              >
                <span className="relative flex items-center justify-center w-3 h-3">
                  <motion.span
                    className="absolute w-3 h-3 rounded-full bg-blue-400/30"
                    animate={{ scale: [1, 2, 1], opacity: [0.6, 0, 0.6] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  />
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                </span>
                Facturation B2B · préparation réforme 2026
              </span>
            </motion.div>

            {/* H1 */}
            <motion.div
              initial={{ opacity: 0, y: 28 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <h1 className="text-[46px] md:text-[58px] text-white leading-[1.06] tracking-[-0.02em]">
                La{" "}
                <span className="relative inline-block">
                  <span
                    style={{
                      background: "linear-gradient(90deg, #60a5fa, #818cf8, #a78bfa)",
                      WebkitBackgroundClip: "text",
                      WebkitTextFillColor: "transparent",
                      backgroundClip: "text",
                    }}
                  >
                    facturation B2B
                  </span>
                  <motion.span
                    className="absolute -bottom-1 left-0 right-0 h-[2px] rounded-full"
                    style={{ background: "linear-gradient(90deg, #60a5fa, #818cf8)" }}
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: 0.8, delay: 0.9, ease: [0.22, 1, 0.36, 1] }}
                  />
                </span>{" "}
                prête pour la réforme
              </h1>
            </motion.div>

            {/* Subtitle */}
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="text-[17px] leading-[1.75]"
              style={{ color: "rgba(148,163,184,1)" }}
            >
              Créez, contrôlez et préparez vos factures B2B en mode export ou connecté selon configuration. Interface
              moderne, conformité pilotée, traçabilité complète.
            </motion.p>

            {/* CTAs */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.48, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-wrap gap-3"
            >
              <motion.a
                href="/app/register"
                className="inline-flex items-center gap-2.5 text-white px-7 py-3.5 rounded-xl text-[15px] font-semibold border-none cursor-pointer"
                style={{ background: "linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%)" }}
                whileHover={{
                  scale: 1.04,
                  boxShadow: "0 0 0 1px rgba(59,130,246,0.5), 0 12px 32px rgba(29,78,216,0.45)",
                }}
                whileTap={{ scale: 0.97 }}
                transition={{ type: "spring", stiffness: 400, damping: 20 }}
              >
                Démarrer gratuitement <ArrowRight size={16} />
              </motion.a>
              <Link
                to="/pricing"
                className="inline-flex items-center gap-2 px-7 py-3.5 rounded-xl text-[15px] font-medium cursor-pointer transition-all duration-200"
                style={{
                  border: "1px solid rgba(255,255,255,0.15)",
                  color: "rgba(203,213,225,1)",
                  background: "rgba(255,255,255,0.05)",
                }}
              >
                Voir les tarifs
              </Link>
            </motion.div>

            {/* Trust row */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.65 }}
              className="flex flex-wrap gap-5 pt-2"
            >
              {[
                { icon: <CheckCircle size={13} />, text: "Hébergement UE/EEE" },
                { icon: <CheckCircle size={13} />, text: "Factur‑X / UBL / CII natif" },
                { icon: <CheckCircle size={13} />, text: "Sans engagement initial" },
              ].map((item, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 text-[12px]"
                  style={{ color: "rgba(100,116,139,1)" }}
                >
                  <span className="text-emerald-500">{item.icon}</span>
                  {item.text}
                </span>
              ))}
            </motion.div>
          </div>

          {/* Right: Dashboard Mockup */}
          <motion.div
            initial={{ opacity: 0, x: 50, scale: 0.94 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            transition={{ duration: 1, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="relative"
          >
            {/* Floating card — Factur-X */}
            <motion.div
              initial={{ opacity: 0, y: 20, x: -10 }}
              animate={{ opacity: 1, y: [0, -6, 0], x: 0 }}
              transition={{
                opacity: { delay: 1.1, duration: 0.6 },
                y: { delay: 1.5, duration: 4, repeat: Infinity, ease: "easeInOut" },
              }}
              className="absolute -top-5 -left-6 z-20 flex items-center gap-3 px-4 py-3 rounded-2xl"
              style={{
                background: "rgba(15,30,54,0.95)",
                border: "1px solid rgba(59,130,246,0.3)",
                backdropFilter: "blur(12px)",
                boxShadow: "0 20px 48px rgba(0,0,0,0.4)",
              }}
            >
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ background: "rgba(29,78,216,0.2)", border: "1px solid rgba(59,130,246,0.3)" }}
              >
                <FileCheck size={16} className="text-blue-400" />
              </div>
              <div>
                <p className="text-[10px] font-medium" style={{ color: "rgba(100,116,139,1)" }}>
                  Contrôle Factur‑X
                </p>
                <p className="text-[13px] font-semibold text-white">Contrôles prêts</p>
              </div>
            </motion.div>

            {/* Floating card — Stats */}
            <motion.div
              initial={{ opacity: 0, y: 20, x: 10 }}
              animate={{ opacity: 1, y: [0, 6, 0], x: 0 }}
              transition={{
                opacity: { delay: 1.3, duration: 0.6 },
                y: { delay: 1.8, duration: 4.5, repeat: Infinity, ease: "easeInOut" },
              }}
              className="absolute -bottom-6 -right-4 z-20 px-5 py-4 rounded-2xl"
              style={{
                background: "rgba(15,30,54,0.95)",
                border: "1px solid rgba(59,130,246,0.2)",
                backdropFilter: "blur(12px)",
                boxShadow: "0 20px 48px rgba(0,0,0,0.4)",
              }}
            >
              <p className="text-[10px] font-medium mb-2" style={{ color: "rgba(100,116,139,1)" }}>
                Exemple suivi PA
              </p>
              <div className="flex items-end gap-2 mb-3">
                <span className="text-[28px] font-bold text-white leading-none">
                  <AnimatedCounter from={70} to={94} suffix="%" duration={2.2} />
                </span>
                <span className="text-[12px] text-emerald-400 mb-0.5 flex items-center gap-0.5">
                  <TrendingUp size={11} />
                  +12%
                </span>
              </div>
              <div className="flex gap-1 items-end">
                {[45, 58, 52, 68, 61, 75, 82, 94].map((h, i) => (
                  <motion.div
                    key={i}
                    className="rounded-sm"
                    style={{
                      width: 8,
                      height: h * 0.38,
                      background: i === 7 ? "linear-gradient(180deg, #3b82f6, #60a5fa)" : "rgba(59,130,246,0.25)",
                      transformOrigin: "bottom",
                    }}
                    initial={{ scaleY: 0 }}
                    animate={{ scaleY: 1 }}
                    transition={{ delay: 1.6 + i * 0.07 }}
                  />
                ))}
              </div>
            </motion.div>

            {/* Dashboard mockup */}
            <div
              className="rounded-2xl overflow-hidden relative"
              style={{
                border: "1px solid rgba(255,255,255,0.08)",
                boxShadow: "0 32px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)",
                background: "#0d1827",
              }}
            >
              {/* Window chrome */}
              <div
                className="flex items-center justify-between px-4 py-3 border-b"
                style={{ borderColor: "rgba(255,255,255,0.06)", background: "#0a1420" }}
              >
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-rose-500/70" />
                  <div className="w-3 h-3 rounded-full bg-amber-500/70" />
                  <div className="w-3 h-3 rounded-full bg-emerald-500/70" />
                </div>
                <span className="text-[11px]" style={{ color: "rgba(71,85,105,1)" }}>
                  facturation-enterprise.app/invoices
                </span>
                <div className="w-16" />
              </div>

              {/* App header */}
              <div
                className="px-5 py-4 border-b flex items-center justify-between"
                style={{ borderColor: "rgba(255,255,255,0.05)" }}
              >
                <div>
                  <p className="text-[13px] font-semibold text-white">Factures émises</p>
                  <p className="text-[11px]" style={{ color: "rgba(71,85,105,1)" }}>
                    Avril 2026 · 24 documents
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="text-[11px] px-2.5 py-1 rounded-lg"
                    style={{
                      background: "rgba(29,78,216,0.2)",
                      color: "#60a5fa",
                      border: "1px solid rgba(59,130,246,0.2)",
                    }}
                  >
                    + Nouvelle facture
                  </span>
                  <span
                    className="text-[11px] px-2.5 py-1 rounded-lg"
                    style={{
                      background: "rgba(255,255,255,0.04)",
                      color: "rgba(100,116,139,1)",
                      border: "1px solid rgba(255,255,255,0.07)",
                    }}
                  >
                    Export
                  </span>
                </div>
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-3 gap-0 border-b" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                {[
                  { label: "Total émis", value: "€58,090", sub: "+8.2% vs mars", color: "text-white" },
                  { label: "Suivi PA", value: "Activable", sub: "mandat requis", color: "text-emerald-400" },
                  { label: "Suivi relances", value: "Config.", sub: "selon règles", color: "text-blue-400" },
                ].map((stat, i) => (
                  <div
                    key={i}
                    className="px-5 py-4"
                    style={{ borderRight: i < 2 ? "1px solid rgba(255,255,255,0.05)" : "none" }}
                  >
                    <p className="text-[10px] mb-1" style={{ color: "rgba(71,85,105,1)" }}>
                      {stat.label}
                    </p>
                    <p className={`text-[16px] font-bold ${stat.color}`}>{stat.value}</p>
                    <p className="text-[10px] text-emerald-500/80 mt-0.5">{stat.sub}</p>
                  </div>
                ))}
              </div>

              {/* Table */}
              <div className="px-5 pt-3 pb-5">
                <div className="grid grid-cols-4 px-2 mb-2">
                  {["N° Facture", "Client", "Montant", "Statut"].map((h) => (
                    <span
                      key={h}
                      className="text-[10px] font-medium uppercase tracking-widest"
                      style={{ color: "rgba(51,65,85,1)" }}
                    >
                      {h}
                    </span>
                  ))}
                </div>
                {invoiceRows.map((row, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.8 + i * 0.1, duration: 0.4 }}
                    className="grid grid-cols-4 items-center px-2 py-2.5 rounded-lg mb-1 group cursor-pointer"
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}
                    whileHover={{ background: "rgba(255,255,255,0.03)" }}
                  >
                    <span className="text-[12px] font-mono text-blue-400">{row.id}</span>
                    <span className="text-[12px] font-medium text-white truncate pr-2">{row.client}</span>
                    <span className="text-[12px] font-semibold text-white">{row.amount}</span>
                    <span className={`text-[11px] font-medium ${row.color}`}>{row.statusLabel}</span>
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.div>
        </div>

        {/* Bottom stats bar */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.9 }}
          className="mt-16 pt-8"
          style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {[
              {
                value: (
                  <>
                    <AnimatedCounter from={0} to={3} suffix="" />+
                  </>
                ),
                label: "Formats natifs",
                sub: "Factur‑X · UBL · CII",
              },
              {
                value: (
                  <>
                    <AnimatedCounter from={0} to={100} suffix="%" />
                  </>
                ),
                label: "Conformité 2027",
                sub: "EN16931 · DGFiP",
              },
              {
                value: (
                  <>
                    <AnimatedCounter from={0} to={6} suffix=" ans" />
                  </>
                ),
                label: "Archivage fiscal",
                sub: "10 ans compta",
              },
              {
                value: "Alertes",
                label: "Supervision",
                sub: "selon contrat",
              },
            ].map((stat, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1 + i * 0.1 }}
                className="flex flex-col"
              >
                <span className="text-[28px] font-bold text-white leading-tight">{stat.value}</span>
                <span className="text-[13px] font-medium mt-1" style={{ color: "rgba(148,163,184,1)" }}>
                  {stat.label}
                </span>
                <span className="text-[11px] mt-0.5" style={{ color: "rgba(71,85,105,1)" }}>
                  {stat.sub}
                </span>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Scroll indicator */}
        <div className="flex justify-center pt-12 pb-4">
          <motion.button
            className="flex flex-col items-center gap-1.5 cursor-pointer bg-transparent border-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2.2, duration: 0.8 }}
            onClick={() => window.scrollBy({ top: window.innerHeight, behavior: "smooth" })}
          >
            <span className="text-[10px] tracking-[0.15em] uppercase" style={{ color: "rgba(71,85,105,1)" }}>
              Découvrir
            </span>
            <div
              className="w-6 h-10 rounded-full flex items-start justify-center pt-2"
              style={{ border: "1px solid rgba(255,255,255,0.12)" }}
            >
              <motion.div
                className="w-1 h-2 rounded-full bg-blue-400"
                animate={{ y: [0, 14, 0], opacity: [1, 0.2, 1] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              />
            </div>
          </motion.button>
        </div>
      </div>
    </section>
  );
}
