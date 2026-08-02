import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Menu, X, ChevronDown } from "lucide-react";
import { Link, useLocation } from "react-router";

const navLinks = [
  { label: "Fonctionnalités", href: "/features" },
  { label: "Tarifs", href: "/pricing" },
  { label: "Sécurité", href: "/security" },
  { label: "FAQ", href: "/faq" },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const location = useLocation();

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 12);
      const totalHeight = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(totalHeight > 0 ? (window.scrollY / totalHeight) * 100 : 0);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const isActive = (href: string) => location.pathname === href;

  return (
    <motion.header
      initial={{ y: -80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      className="fixed top-0 left-0 right-0 z-50"
    >
      <motion.div
        animate={{
          backgroundColor: scrolled ? "rgba(7,13,26,0.92)" : "rgba(7,13,26,0)",
          backdropFilter: scrolled ? "blur(20px) saturate(180%)" : "blur(0px)",
          borderBottom: scrolled ? "1px solid rgba(255,255,255,0.06)" : "1px solid transparent",
        }}
        transition={{ duration: 0.4 }}
        className="w-full relative"
      >
        {/* Scroll progress bar */}
        <motion.div
          className="absolute top-0 left-0 h-[2px] pointer-events-none"
          style={{
            width: `${progress}%`,
            background: "linear-gradient(90deg, #1d4ed8, #3b82f6, #60a5fa)",
            opacity: scrolled ? 1 : 0,
          }}
          transition={{ duration: 0.1 }}
        />
        <div className="max-w-[1200px] mx-auto px-6 h-[68px] flex items-center justify-between">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-3 shrink-0">
            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} className="flex items-center gap-3">
              <div
                className="relative w-9 h-9 rounded-xl flex items-center justify-center overflow-hidden"
                style={{ background: "linear-gradient(135deg, #1e40af 0%, #3b82f6 50%, #60a5fa 100%)" }}
              >
                <span className="text-white text-[12px] font-black tracking-tighter relative z-10">FX</span>
                <div className="absolute inset-0 bg-white/10 rounded-xl" />
              </div>
              <div className="flex flex-col leading-none">
                <span className="text-[14px] font-bold text-white tracking-tight">PixFacture</span>
                <span className="text-[10px] text-blue-400/80 tracking-[0.06em]">Factur‑X · Connecteurs PA</span>
              </div>
            </motion.div>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map((link, i) => (
              <motion.div
                key={link.href}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + i * 0.07, duration: 0.4 }}
              >
                <Link
                  to={link.href}
                  className={`relative px-4 py-2 rounded-lg text-[13px] font-medium transition-all duration-200 ${
                    isActive(link.href) ? "text-white bg-white/10" : "text-slate-400 hover:text-white hover:bg-white/8"
                  }`}
                  style={isActive(link.href) ? {} : {}}
                >
                  {link.label}
                  {isActive(link.href) && (
                    <motion.div
                      layoutId="nav-active"
                      className="absolute inset-0 rounded-lg bg-white/10"
                      transition={{ type: "spring", stiffness: 380, damping: 30 }}
                    />
                  )}
                </Link>
              </motion.div>
            ))}
          </nav>

          {/* Desktop CTAs */}
          <div className="hidden md:flex items-center gap-2">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.45 }}>
              <Link
                to="/app/login"
                className="text-[13px] text-slate-400 hover:text-white transition-colors px-4 py-2 rounded-lg font-medium"
              >
                Se connecter
              </Link>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.5 }}
            >
              <Link
                to="/app/register"
                className="text-[13px] font-semibold text-white px-5 py-2.5 rounded-xl border-none cursor-pointer transition-all inline-block"
                style={{ background: "linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%)" }}
              >
                Créer un compte
              </Link>
            </motion.div>
          </div>

          {/* Mobile burger */}
          <motion.button
            className="md:hidden p-2 rounded-xl text-slate-300 bg-transparent border-none cursor-pointer"
            onClick={() => setMobileOpen(!mobileOpen)}
            whileTap={{ scale: 0.9 }}
          >
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </motion.button>
        </div>
      </motion.div>

      {/* Mobile menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden md:hidden"
            style={{ backgroundColor: "rgba(7,13,26,0.97)", borderBottom: "1px solid rgba(255,255,255,0.07)" }}
          >
            <div className="px-6 py-5 flex flex-col gap-1">
              {navLinks.map((link, i) => (
                <motion.div
                  key={link.label}
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.07 }}
                >
                  <Link
                    to={link.href}
                    onClick={() => setMobileOpen(false)}
                    className={`block px-4 py-3 rounded-xl text-[15px] font-medium transition-colors ${
                      isActive(link.href)
                        ? "text-white bg-white/10"
                        : "text-slate-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    {link.label}
                  </Link>
                </motion.div>
              ))}
              <div className="flex gap-3 pt-4 mt-2 border-t border-white/8">
                <Link
                  to="/app/login"
                  onClick={() => setMobileOpen(false)}
                  className="flex-1 text-center text-[14px] text-slate-300 border border-white/15 py-3 rounded-xl bg-transparent font-medium"
                >
                  Se connecter
                </Link>
                <Link
                  to="/app/register"
                  onClick={() => setMobileOpen(false)}
                  className="flex-1 text-center text-[14px] font-semibold text-white py-3 rounded-xl border-none"
                  style={{ background: "linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%)" }}
                >
                  Créer un compte
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  );
}
