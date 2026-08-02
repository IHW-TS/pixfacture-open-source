import { motion } from "motion/react";
import { Link } from "react-router";
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
    { label: "Contact", href: "/contact" },
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
    href: "https://www.economie.gouv.fr/tout-savoir-sur-la-facturation-electronique-pour-les-entreprises",
  },
  { label: "Liste PA agréées", href: "https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees" },
];

export function Footer() {
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
                <span className="text-[10px] text-blue-500 tracking-wide">Chorus · Factur‑X · DGFiP</span>
              </div>
            </div>

            <p className="text-[13px] leading-[1.75] mb-5" style={{ color: "rgba(71,85,105,1)" }}>
              Logiciel de facturation B2B — génération Factur‑X, contrôles de cohérence, connecteur plateforme agréée.
            </p>

            <div className="flex flex-col gap-1.5 mb-6">
              {["Factur‑X / UBL / CII natif", "Réforme 2026–2027 prête", "Hébergement UE/EEE"].map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-2 text-[12px]"
                  style={{ color: "rgba(51,65,85,1)" }}
                >
                  <span className="w-1 h-1 rounded-full bg-blue-800" />
                  {t}
                </span>
              ))}
            </div>
          </div>

          {/* Nav columns */}
          {Object.entries(footerLinks).map(([category, links]) => (
            <div key={category}>
              <p
                className="text-[11px] font-semibold uppercase tracking-[0.1em] mb-4"
                style={{ color: "rgba(51,65,85,1)" }}
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
                        style={{ color: "rgba(71,85,105,1)" }}
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
          <p className="text-[12px] leading-[1.75]" style={{ color: "rgba(51,65,85,1)" }}>
            <strong style={{ color: "rgba(71,85,105,1)" }}>PixFacture</strong> est un logiciel de facturation B2B :
            Factur‑X / UBL / CII + contrôles, connecteurs PA selon configuration. Nous ne sommes pas une plateforme
            agréée (PA, ex‑PDP). Les informations sur la réforme sont fournies à titre informatif (
            {externalLinks.map((l, i) => (
              <span key={i}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-blue-400 transition-colors underline underline-offset-2"
                  style={{ color: "rgba(59,130,246,0.6)" }}
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
          <p className="text-[12px]" style={{ color: "rgba(30,41,59,1)" }}>
            © 2026–2027 PixFacture · Tous droits réservés
          </p>
          <div className="flex items-center gap-4">
            {["Mentions légales", "Confidentialité", "CGU"].map((label, i) => (
              <Link
                key={i}
                to={i === 0 ? "/legal/mentions" : i === 1 ? "/legal/privacy" : "/legal/terms"}
                className="text-[11px] transition-colors hover:text-slate-400"
                style={{ color: "rgba(30,41,59,1)" }}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
