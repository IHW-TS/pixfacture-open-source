import { Link } from "react-router";
import { Shield, CheckCircle2, ArrowRight, Zap, Lock, Globe } from "lucide-react";
import { motion } from "motion/react";

interface AuthLayoutProps {
  children: React.ReactNode;
  pill: string;
  title?: string;
  subtitle?: string;
}

const features = [
  {
    icon: CheckCircle2,
    label: "Export Factur-X Pro",
    desc: "PDF + XML après contrôles requis",
    color: "text-[#34d399]",
    bg: "bg-[#34d399]/10",
  },
  {
    icon: Zap,
    label: "E-reporting Pro",
    desc: "Préparation et export selon périmètre",
    color: "text-[#60a5fa]",
    bg: "bg-[#60a5fa]/10",
  },
  {
    icon: Lock,
    label: "Multi-entreprise sécurisé",
    desc: "Isolation complète par entreprise",
    color: "text-[#a78bfa]",
    bg: "bg-[#a78bfa]/10",
  },
  {
    icon: Globe,
    label: "Canal public B2G",
    desc: "Connecteur activable si configuré",
    color: "text-[#fb923c]",
    bg: "bg-[#fb923c]/10",
  },
];

const stats = [
  { value: "EN16931", label: "Contrôles facture" },
  { value: "PDF", label: "Facturation classique" },
  { value: "RBAC", label: "Accès sécurisés" },
];

export function AuthLayout({ children, pill }: AuthLayoutProps) {
  return (
    <div className="min-h-screen flex bg-white">
      {/* Left branding panel */}
      <div
        className="hidden lg:flex lg:w-[520px] xl:w-[560px] flex-col relative overflow-hidden"
        style={{ background: "linear-gradient(160deg, #060f20 0%, #0d1e38 50%, #0a1628 100%)" }}
      >
        {/* Background layers */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-[-60px] right-[-60px] w-96 h-96 rounded-full bg-[#1d4ed8]/25 blur-[120px]" />
          <div className="absolute bottom-[-80px] left-[-40px] w-80 h-80 rounded-full bg-[#7c3aed]/20 blur-[100px]" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 rounded-full bg-[#059669]/10 blur-[80px]" />
          {/* Grid pattern */}
          <div
            className="absolute inset-0 opacity-[0.04]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)",
              backgroundSize: "40px 40px",
            }}
          />
        </div>

        <div className="relative z-10 flex flex-col h-full p-10">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-3 w-fit group">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#3b82f6] to-[#6366f1] flex items-center justify-center shadow-lg shadow-[#1d4ed8]/30 group-hover:shadow-[#1d4ed8]/50 transition-shadow">
              <Shield className="w-5 h-5 text-white" style={{ strokeWidth: 2 }} />
            </div>
            <div>
              <span
                className="text-white block"
                style={{ fontWeight: 700, fontSize: "1.125rem", letterSpacing: "-0.01em", lineHeight: 1.2 }}
              >
                PixFacture
              </span>
              <span className="text-white/30 block" style={{ fontSize: "0.6875rem", letterSpacing: "0.06em" }}>
                FACTURATION B2B
              </span>
            </div>
          </Link>

          {/* Main content */}
          <div className="flex-1 flex flex-col justify-center py-8">
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.15 }}
              className="mb-10"
            >
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/8 border border-white/10 mb-6">
                <span className="w-1.5 h-1.5 rounded-full bg-[#34d399] animate-pulse" />
                <span className="text-white/70" style={{ fontSize: "0.6875rem", fontWeight: 500 }}>
                  Logiciel de facturation · réforme 2026
                </span>
              </div>
              <h2
                className="text-white mb-4"
                style={{ fontSize: "2rem", fontWeight: 800, lineHeight: 1.2, letterSpacing: "-0.03em" }}
              >
                Facturation B2B
                <br />
                <span
                  style={{
                    background: "linear-gradient(135deg, #60a5fa, #a78bfa)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                  }}
                >
                  claire & structurée
                </span>
              </h2>
              <p className="text-white/45 max-w-xs" style={{ fontSize: "0.9rem", lineHeight: 1.7 }}>
                Facturation PDF en Starter. Exports structurés et connecteurs avec Pro, selon contrat, mandat et
                configuration.
              </p>
            </motion.div>

            {/* Features */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              className="space-y-3 mb-10"
            >
              {features.map((f, i) => (
                <motion.div
                  key={f.label}
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: 0.4 + i * 0.08 }}
                  className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.04] border border-white/[0.06] backdrop-blur-sm hover:bg-white/[0.07] transition-colors"
                >
                  <div className={`w-8 h-8 rounded-lg ${f.bg} flex items-center justify-center flex-shrink-0`}>
                    <f.icon className={`w-4 h-4 ${f.color}`} style={{ strokeWidth: 2 }} />
                  </div>
                  <div>
                    <div className="text-white/90" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                      {f.label}
                    </div>
                    <div className="text-white/35" style={{ fontSize: "0.6875rem" }}>
                      {f.desc}
                    </div>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 text-white/20 ml-auto" />
                </motion.div>
              ))}
            </motion.div>

            {/* Stats */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.7 }}
              className="grid grid-cols-3 gap-3"
            >
              {stats.map((s) => (
                <div key={s.label} className="text-center p-3 rounded-xl bg-white/[0.04] border border-white/[0.06]">
                  <div className="text-white" style={{ fontSize: "1rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
                    {s.value}
                  </div>
                  <div className="text-white/35" style={{ fontSize: "0.625rem", marginTop: "2px" }}>
                    {s.label}
                  </div>
                </div>
              ))}
            </motion.div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between">
            <span className="text-white/20" style={{ fontSize: "0.6875rem" }}>
              &copy; 2026 PixFacture
            </span>
            <div className="flex items-center gap-3">
              {["CGU", "Confidentialité", "Aide"].map((l) => (
                <a
                  key={l}
                  href="#"
                  className="text-white/20 hover:text-white/40 transition-colors"
                  style={{ fontSize: "0.6875rem" }}
                >
                  {l}
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex-1 flex flex-col min-h-screen bg-[#fafbfc]">
        {/* Mobile header */}
        <header className="lg:hidden py-4 px-5 border-b border-[#e2e8f0] bg-white">
          <Link to="/" className="flex items-center gap-2.5 w-fit">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#1d4ed8] to-[#4f46e5] flex items-center justify-center shadow-md">
              <Shield className="w-4 h-4 text-white" />
            </div>
            <span className="text-[#0f172a]" style={{ fontWeight: 700, fontSize: "1.05rem" }}>
              PixFacture
            </span>
          </Link>
        </header>

        <main className="flex-1 flex items-center justify-center px-5 py-10">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="w-full max-w-[420px]"
          >
            <div
              className="inline-flex items-center px-3 py-1 rounded-lg bg-[#eff6ff] border border-[#dbeafe] text-[#1d4ed8] mb-6"
              style={{ fontSize: "0.6875rem", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}
            >
              {pill}
            </div>
            {children}
          </motion.div>
        </main>
      </div>
    </div>
  );
}
