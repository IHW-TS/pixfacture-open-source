"use client";

import { logout } from "@/lib/authCookies";
import { useAnimatedPresence } from "@/lib/useAnimatedPresence";
import { useSession } from "@/lib/useSession";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

export default function NavBar() {
  const pathname = usePathname();
  const isAppRoute = Boolean(pathname?.startsWith("/app"));
  const isHomeRoute = pathname === "/";
  const isMarketingRoute = !isAppRoute;
  const shouldRefreshSession = isAppRoute || pathname?.startsWith("/admin");
  const showMarketingLinks = isMarketingRoute;
  const showHomeDark = isHomeRoute;
  const marketingLinks = isHomeRoute
    ? [
        { label: "Fonctionnalités", href: "/#features" },
        { label: "Tarifs", href: "/#pricing" },
        { label: "Sécurité", href: "/#security" },
        { label: "FAQ", href: "/#faq" },
      ]
    : [
        { label: "Fonctionnalités", href: "/features" },
        { label: "Tarifs", href: "/pricing" },
        { label: "Sécurité", href: "/security" },
        { label: "FAQ", href: "/faq" },
      ];
  const { loading, user } = useSession({ autoRefresh: shouldRefreshSession });
  const isLoggedIn = Boolean(user);
  const role = (user?.role || "").toLowerCase();
  const tenantName = [user?.tenant_name, user?.company_name].find((value) => value && value.trim());
  const tenantLabel = (tenantName || user?.tenant_id || "").trim();
  const roleLabel =
    user?.is_admin || role === "owner" || role === "admin"
      ? "Espace Admin"
      : role === "accountant"
        ? "Espace Comptabilité"
        : role === "viewer"
          ? "Espace Lecture"
          : "Espace Client";
  const chipSub = tenantLabel ? `${roleLabel} / ${tenantLabel}` : roleLabel;
  const maskedEmail = maskEmail(user?.email);
  const chipTitle = maskedEmail ? `Compte: ${maskedEmail}` : "Statut connecté";

  const [menuOpen, setMenuOpen] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const { mounted: menuMounted, state: menuState } = useAnimatedPresence(menuOpen, { exitMs: 180 });

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (menuMounted) {
      document.body.classList.add("no-scroll");
    } else {
      document.body.classList.remove("no-scroll");
    }
    return () => {
      document.body.classList.remove("no-scroll");
    };
  }, [menuMounted]);

  useEffect(() => {
    if (typeof window === "undefined" || !showMarketingLinks) return;
    const updateProgress = () => {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const next = maxScroll > 0 ? (window.scrollY / maxScroll) * 100 : 0;
      setScrollProgress(Math.max(0, Math.min(100, next)));
    };
    updateProgress();
    window.addEventListener("scroll", updateProgress, { passive: true });
    window.addEventListener("resize", updateProgress);
    return () => {
      window.removeEventListener("scroll", updateProgress);
      window.removeEventListener("resize", updateProgress);
    };
  }, [showMarketingLinks, pathname]);

  const isActive = useMemo(() => {
    const current = pathname || "";
    return (href: string) => current === href || current.startsWith(`${href}/`);
  }, [pathname]);

  return (
    <header
      className={`nav ${menuOpen ? "nav-open" : ""} ${showMarketingLinks ? "nav--figma" : ""} ${
        showHomeDark ? "nav--home-dark" : ""
      }`}
    >
      {showHomeDark ? <progress className="nav-progress" aria-hidden="true" value={scrollProgress} max={100} /> : null}
      <div className="nav-inner">
        <div className="nav-left">
          <Link className="brand" href="/" aria-label="Accueil">
            <span className={`brand-mark ${showMarketingLinks ? "brand-mark--figma" : ""}`}>FX</span>
            <div className="brand-text">
              <span className="brand-title">PixFacture</span>
              {showMarketingLinks ? <span className="brand-sub">Facturation B2B · Réforme 2026</span> : null}
              {!showMarketingLinks ? <span className="brand-sub">Chorus • Factur-X</span> : null}
            </div>
          </Link>

          {showMarketingLinks ? (
            <nav className="nav-links" aria-label="Navigation principale">
              {marketingLinks.map((link) => {
                const active = isHomeRoute ? false : isActive(link.href);
                return (
                  <Link
                    key={link.href}
                    className={active ? "active" : ""}
                    aria-current={active ? "page" : undefined}
                    href={link.href}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
          ) : null}
        </div>

        <div className="nav-right">
          <div className="nav-auth">
            {loading ? (
              <div className="muted">Chargement…</div>
            ) : isLoggedIn ? (
              <>
                <div className="nav-chip online" title={chipTitle}>
                  <span className="chip-dot" aria-hidden="true"></span>
                  <div>
                    <div className="chip-title">Connecté</div>
                    <div className="chip-sub">{chipSub}</div>
                  </div>
                </div>
                <Link className="btn-link" href="/app/dashboard">
                  Tableau de bord
                </Link>
                <button
                  className="btn ghost nav-logout"
                  onClick={() => {
                    void logout();
                  }}
                >
                  Déconnexion
                </button>
              </>
            ) : (
              <>
                <Link className="btn-link" href="/app/login">
                  Se connecter
                </Link>
                <Link className="btn" href="/app/register?plan=pro">
                  Essayer gratuitement
                </Link>
              </>
            )}
          </div>

          {showMarketingLinks ? (
            <button
              type="button"
              className="nav-toggle"
              aria-label={menuOpen ? "Fermer le menu" : "Ouvrir le menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((prev) => !prev)}
            >
              <span aria-hidden="true" className="nav-toggle__icon" />
            </button>
          ) : null}
        </div>
      </div>

      {showMarketingLinks && menuMounted ? (
        <button
          type="button"
          className="nav-overlay ui-overlay ui-overlay--dim"
          data-state={menuState}
          aria-label="Fermer le menu"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}
    </header>
  );
}

function maskEmail(value?: string | null) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("@");
  if (parts.length < 2) return "***";
  const [local, domain] = parts;
  if (!domain) return "***";
  const head = local.slice(0, 1) || "*";
  const maskedTail = "*".repeat(Math.max(1, Math.min(6, local.length - 1)));
  return `${head}${maskedTail}@${domain}`;
}
