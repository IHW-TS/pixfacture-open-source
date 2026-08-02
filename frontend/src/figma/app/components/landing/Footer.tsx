"use client";
import { motion } from "motion/react";
import { Link } from "@/figma/react-router-compat";
import { getLegalConfig } from "@/lib/legalConfig";
import { getSourceCodeUrl } from "@/lib/sourceCode";
import { AnimatedSection } from "./AnimatedSection";

const footerLinks = {
  Produit: [
    { label: "Fonctionnalités", href: "/features" },
    { label: "Tarifs", href: "/pricing" },
    { label: "Conformité 2026–2027", href: "/conformite-2026" },
    { label: "Plateformes agréées", href: "/plateformes" },
    { label: "Compatibilité", href: "/compatibilite-einvoicing" },
  ],
  Ressources: [
    { label: "Centre de confiance", href: "/confiance" },
    { label: "Sécurité", href: "/security" },
    { label: "FAQ", href: "/faq" },
    { label: "Accessibilité", href: "/accessibilite" },
    { label: "Support & contact", href: "/contact" },
  ],
  Légal: [
    { label: "Mentions légales", href: "/legal/mentions" },
    { label: "Confidentialité", href: "/legal/privacy" },
    { label: "CGV/CGU", href: "/legal/terms" },
    { label: "Cookies", href: "/legal/cookies" },
    { label: "DPA RGPD", href: "/legal/dpa" },
    { label: "SLA", href: "/legal/sla" },
    { label: "Périmètre e-invoicing", href: "/legal/einvoicing-scope" },
  ],
};

const externalLinks = [
  { label: "Spéc. B2B DGFiP", href: "https://www.impots.gouv.fr/specifications-externes-b2b" },
  {
    label: "Calendrier officiel",
    href: "https://www.impots.gouv.fr/professionnel/je-passe-la-facturation-electronique",
  },
  { label: "Liste PA agréées", href: "https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees" },
];

export function Footer() {
  const { supportEmail } = getLegalConfig();
  const sourceCodeUrl = getSourceCodeUrl();

  return (
    <footer style={{ background: "#050c17" }}>
      {/* Top border glow */}
      <div
        className="h-px w-full"
        style={{ background: "linear-gradient(90deg, transparent, rgba(59,130,246,0.25), transparent)" }}
      />

      <div className="max-w-[1200px] mx-auto px-6 pt-16 pb-10">
        <AnimatedSection className="grid grid-cols-2 md:grid-cols-5 gap-8 mb-14">
          {/* Brand */}
          <div className="col-span-2">
            <div className="flex items-center gap-3 mb-6">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shadow-lg"
                style={{ background: "linear-gradient(135deg, #1e40af 0%, #3b82f6 100%)" }}
              >
                <span className="text-white text-[13px] font-black tracking-tighter">FX</span>
              </div>
              <div className="flex flex-col leading-none">
                <span className="text-[14px] font-bold text-white tracking-tight">PixFacture</span>
                <span className="text-[10px] text-blue-400 tracking-wide">Facturation B2B · Réforme 2026</span>
              </div>
            </div>

            <p className="text-[13px] leading-[1.75] mb-5" style={{ color: "rgba(148,163,184,0.88)" }}>
              Logiciel de facturation B2B — devis, factures, contrôles de cohérence et exports structurés selon
              configuration.
            </p>

            <div className="flex flex-col gap-1.5 mb-6">
              {[
                "Exports Factur‑X/CII · UBL avec Pro selon configuration",
                "Préparation réforme 2026–2027",
                "Hébergement UE/EEE selon l'instance",
              ].map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-2 text-[12px]"
                  style={{ color: "rgba(148,163,184,0.84)" }}
                >
                  <span className="w-1 h-1 rounded-full bg-blue-800" />
                  {t}
                </span>
              ))}
            </div>

            <div
              className="rounded-2xl p-4 mb-6"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
            >
              <p
                className="text-[11px] font-semibold uppercase tracking-[0.1em] mb-2"
                style={{ color: "rgba(148,163,184,0.82)" }}
              >
                Support public
              </p>
              <div className="flex flex-col gap-1">
                <a
                  href={`mailto:${supportEmail}`}
                  className="text-[13px] font-medium hover:text-white transition-colors"
                  style={{ color: "rgba(226,232,240,0.96)" }}
                >
                  {supportEmail}
                </a>
                {supportEmail && (
                  <p className="text-[12px]" style={{ color: "rgba(148,163,184,0.82)" }}>
                    Contact produit, questions commerciales et demandes RGPD.
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Nav columns */}
          {Object.entries(footerLinks).map(([category, links]) => (
            <div key={category}>
              <p
                className="text-[11px] font-semibold uppercase tracking-[0.1em] mb-4"
                style={{ color: "rgba(148,163,184,0.82)" }}
              >
                {category}
              </p>
              <ul className="flex flex-col gap-2">
                {links.map((link) => (
                  <li key={link.label}>
                    <motion.div whileHover={{ x: 2 }} transition={{ type: "spring", stiffness: 400 }}>
                      <Link
                        to={link.href}
                        className="text-[13px] transition-colors hover:text-white"
                        style={{ color: "rgba(203,213,225,0.86)" }}
                      >
                        {link.label}
                      </Link>
                    </motion.div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </AnimatedSection>

        {/* Compliance disclaimer */}
        <div
          className="rounded-2xl p-5 mb-8"
          style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}
        >
          <p className="text-[12px] leading-[1.75]" style={{ color: "rgba(148,163,184,0.82)" }}>
            <strong style={{ color: "rgba(226,232,240,0.92)" }}>PixFacture</strong> est un logiciel de facturation B2B :
            PDF en Starter ; Factur‑X/CII/UBL, canal public B2G et préparation de connecteurs PA avec Pro selon
            artefact, contrat, mandat et configuration opérationnelle. Nous ne sommes pas une plateforme agréée (PA,
            ex‑PDP). Les informations sur la réforme sont fournies à titre informatif (
            {externalLinks.map((l, i) => (
              <span key={i}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-blue-400 transition-colors underline underline-offset-2"
                  style={{ color: "rgba(96,165,250,0.88)" }}
                >
                  {l.label}
                </a>
                {i < externalLinks.length - 1 && " · "}
              </span>
            ))}
            ). Le service ne constitue pas un conseil fiscal/juridique.
          </p>
        </div>

        {/* Bottom bar */}
        <div
          className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-6"
          style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
        >
          <p className="text-[12px]" style={{ color: "rgba(148,163,184,0.84)" }}>
            © 2026–2027 PixFacture · Tous droits réservés
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            {[
              { label: "Mentions légales", href: "/legal/mentions" },
              { label: "Confidentialité", href: "/legal/privacy" },
              { label: "CGU", href: "/legal/terms" },
              { label: "Accessibilité : non conforme", href: "/accessibilite" },
            ].map((link) => (
              <Link
                key={link.href}
                to={link.href}
                className="text-[11px] transition-colors hover:text-slate-400"
                style={{ color: "rgba(148,163,184,0.84)" }}
              >
                {link.label}
              </Link>
            ))}
            <a
              href={sourceCodeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] transition-colors hover:text-slate-400"
              style={{ color: "rgba(148,163,184,0.84)" }}
            >
              Code source (AGPL)
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
