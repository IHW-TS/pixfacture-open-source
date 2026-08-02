"use client";
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Menu, X, ChevronDown } from "lucide-react";
import { Link, useLocation } from "@/figma/react-router-compat";

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
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const isHome = location.pathname === "/";
  const forceSolidNavbar = !isHome;

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 12);
      const totalHeight = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(totalHeight > 0 ? (window.scrollY / totalHeight) * 100 : 0);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileOpen(false);
      window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  const isActive = (href: string) => location.pathname === href;

  return (
    <motion.header
      initial={false}
      className="fixed top-0 left-0 right-0 z-50"
      style={forceSolidNavbar ? { backgroundColor: "#070d1a" } : undefined}
    >
      <motion.div
        animate={{
          backgroundColor: forceSolidNavbar ? "#070d1a" : scrolled ? "rgba(7,13,26,0.92)" : "rgba(7,13,26,0)",
          backdropFilter: scrolled || forceSolidNavbar ? "blur(20px) saturate(180%)" : "blur(0px)",
          borderBottom: scrolled || forceSolidNavbar ? "1px solid rgba(255,255,255,0.06)" : "1px solid transparent",
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
            opacity: scrolled || forceSolidNavbar ? 1 : 0,
          }}
          transition={{ duration: 0.1 }}
        />
        <div className="max-w-[1248px] mx-auto px-6 h-[72px] flex items-center justify-between">
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
                <span className="hidden text-[10px] text-blue-300/90 tracking-[0.06em] sm:block">
                  Facturation B2B · Réforme 2026
                </span>
              </div>
            </motion.div>
          </Link>

          {/* Desktop nav */}
          <nav aria-label="Navigation principale" className="hidden md:flex items-center gap-1">
            {navLinks.map((link, i) => (
              <motion.div key={link.href} initial={false} transition={{ delay: 0.1 + i * 0.07, duration: 0.4 }}>
                <Link
                  to={link.href}
                  className={`relative px-4 py-2 rounded-lg text-[13px] font-medium transition-all duration-200 ${
                    isActive(link.href) ? "text-white bg-white/10" : "text-slate-300 hover:text-white hover:bg-white/10"
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
            <motion.div initial={false} transition={{ delay: 0.45 }}>
              <Link
                to="/app/login"
                className="text-[13px] text-slate-200 hover:text-white hover:bg-white/8 transition-colors px-4 py-2 rounded-lg font-medium"
              >
                Se connecter
              </Link>
            </motion.div>
            <motion.div initial={false} transition={{ delay: 0.5 }}>
              <Link
                to="/app/register?plan=pro"
                className="inline-block rounded-xl border-none px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_12px_28px_rgba(37,99,235,0.32)] transition-all hover:shadow-[0_16px_34px_rgba(37,99,235,0.38)]"
                style={{ background: "linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)" }}
              >
                Essayer gratuitement
              </Link>
            </motion.div>
          </div>

          {/* Mobile burger */}
          <motion.button
            ref={mobileMenuButtonRef}
            aria-controls="landing-mobile-menu"
            aria-expanded={mobileOpen}
            aria-label={mobileOpen ? "Fermer le menu de navigation" : "Ouvrir le menu de navigation"}
            className="md:hidden p-2 rounded-xl text-slate-300 bg-transparent border-none cursor-pointer"
            onClick={() => setMobileOpen(!mobileOpen)}
            whileTap={{ scale: 0.9 }}
          >
            {mobileOpen ? <X aria-hidden="true" size={22} /> : <Menu aria-hidden="true" size={22} />}
          </motion.button>
        </div>
      </motion.div>

      {/* Mobile menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            id="landing-mobile-menu"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-x-hidden overflow-y-auto overscroll-contain md:hidden"
            style={{
              maxHeight: "calc(100dvh - 72px)",
              backgroundColor: "rgba(7,13,26,0.97)",
              borderBottom: "1px solid rgba(255,255,255,0.07)",
            }}
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
                        : "text-slate-200 hover:text-white hover:bg-white/8"
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
                  className="flex-1 rounded-xl border border-white/15 bg-white/5 py-3 text-center text-[14px] font-medium text-slate-100"
                >
                  Se connecter
                </Link>
                <Link
                  to="/app/register?plan=pro"
                  onClick={() => setMobileOpen(false)}
                  className="flex-1 rounded-xl border-none py-3 text-center text-[14px] font-semibold text-white"
                  style={{
                    background: "linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)",
                    boxShadow: "0 14px 28px rgba(37,99,235,0.28)",
                  }}
                >
                  Essayer gratuitement
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  );
}
