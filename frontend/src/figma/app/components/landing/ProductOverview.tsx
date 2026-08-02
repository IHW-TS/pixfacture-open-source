"use client";
import { useRef } from "react";
import { motion, useInView } from "motion/react";
import { CheckCircle2, XCircle, ArrowRight, FileText, Shield } from "lucide-react";
import { InvoiceIllustration, ArchiveIllustration } from "./Illustrations";

interface BulletItem {
  text: string;
  ok: boolean;
}

interface BlockProps {
  tag: string;
  title: string;
  subtitle: string;
  bullets: BulletItem[];
  link: string;
  linkHref: string;
  illustration: React.ReactNode;
  reverse?: boolean;
  overlayCards?: React.ReactNode;
}

function ProductBlock({
  tag,
  title,
  subtitle,
  bullets,
  link,
  linkHref,
  illustration,
  reverse = false,
  overlayCards,
}: BlockProps) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <div ref={ref} className={`grid lg:grid-cols-2 gap-14 lg:gap-20 items-center`}>
      {/* Text side */}
      <motion.div
        initial={{ opacity: 0, x: reverse ? 40 : -40 }}
        animate={isInView ? { opacity: 1, x: 0 } : {}}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className={`flex flex-col gap-6 ${reverse ? "lg:order-2" : ""}`}
      >
        <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600">{tag}</span>
        <h3 className="text-[28px] md:text-[34px] font-bold text-slate-900 leading-[1.15] tracking-tight">{title}</h3>
        <p className="text-[15px] text-slate-500 leading-[1.7]">{subtitle}</p>

        <ul className="flex flex-col gap-3">
          {bullets.map((b, i) => (
            <motion.li
              key={i}
              initial={{ opacity: 0, x: -14 }}
              animate={isInView ? { opacity: 1, x: 0 } : {}}
              transition={{ delay: 0.3 + i * 0.08, duration: 0.5 }}
              className="flex items-start gap-3 text-[14px]"
            >
              {b.ok ? (
                <CheckCircle2 size={16} className="text-blue-600 mt-0.5 shrink-0" />
              ) : (
                <XCircle size={16} className="text-slate-300 mt-0.5 shrink-0" />
              )}
              <span className={b.ok ? "text-slate-700" : "text-slate-400"}>{b.text}</span>
            </motion.li>
          ))}
        </ul>

        <motion.a
          href={linkHref}
          className="inline-flex items-center gap-2 text-blue-600 text-[14px] font-semibold bg-transparent border-none cursor-pointer self-start group"
          whileHover={{ x: 4 }}
          transition={{ type: "spring", stiffness: 400 }}
        >
          {link}
          <ArrowRight size={14} className="transition-transform group-hover:translate-x-1" />
        </motion.a>
      </motion.div>

      {/* Illustration side */}
      <motion.div
        initial={{ opacity: 0, x: reverse ? -40 : 40, scale: 0.96 }}
        animate={isInView ? { opacity: 1, x: 0, scale: 1 } : {}}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        className={`relative ${reverse ? "lg:order-1" : ""}`}
      >
        <motion.div
          className="rounded-2xl overflow-hidden aspect-[4/3] relative"
          style={{ border: "1px solid #e2e8f0", boxShadow: "0 24px 64px rgba(0,0,0,0.08)" }}
          whileHover={{ scale: 1.02, boxShadow: "0 32px 80px rgba(0,0,0,0.12)" }}
          transition={{ type: "spring", stiffness: 200, damping: 25 }}
        >
          {illustration}
        </motion.div>
        {overlayCards}
      </motion.div>
    </div>
  );
}

export function ProductOverview() {
  return (
    <section className="py-24 md:py-32" style={{ background: "#f8fafc" }}>
      <div className="max-w-[1200px] mx-auto px-6">
        <div className="flex flex-col gap-24 md:gap-32">
          <ProductBlock
            tag="Formats · Modes · Contrôles"
            title="Factures B2B contrôlées, connectées ou exportées"
            subtitle="La même interface pour facturer en PDF, puis activer Factur‑X, contrôles et transmission en Pro selon plan, mandat et configuration PA."
            bullets={[
              { text: "Factur‑X (PDF + XML/CII) disponible en Pro avec configuration stricte.", ok: true },
              { text: "Validation normative (XSD/Schematron) si configurée sur votre plan.", ok: true },
              { text: "Gestion clients, articles, TVA, numérotation séquentielle, export CSV/journal.", ok: true },
              { text: "Connecteur plateforme agréée (PA, ex‑PDP) activable selon votre contrat.", ok: true },
              { text: "Nous ne sommes pas une plateforme agréée immatriculée.", ok: false },
            ]}
            link="Voir les modes d'intégration"
            linkHref="/features"
            illustration={<InvoiceIllustration />}
            overlayCards={
              <>
                <motion.div
                  className="absolute -top-5 -right-5 px-4 py-3 rounded-2xl flex items-center gap-3"
                  style={{
                    background: "white",
                    border: "1px solid #e2e8f0",
                    boxShadow: "0 16px 48px rgba(0,0,0,0.12)",
                  }}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.8 }}
                  whileHover={{ y: -3 }}
                >
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center"
                    style={{ background: "linear-gradient(135deg, #1d4ed8, #3b82f6)" }}
                  >
                    <FileText size={16} className="text-white" />
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-400">Contrôle XSD</p>
                    <p className="text-[13px] font-bold text-slate-900">Validé ✓</p>
                  </div>
                </motion.div>
              </>
            }
          />

          <ProductBlock
            tag="Légal · Conformité · Traçabilité"
            title="Pilotage centralisé des flux documentaires"
            subtitle="Suivi des statuts, journal d'audit et exports documentaires. Tout ce qu'il faut pour une traçabilité claire."
            bullets={[
              { text: "Suivi centralisé : exports, journal d'audit, statuts selon connecteur activé.", ok: true },
              { text: "Rétention et stockage renforcés selon configuration.", ok: true },
              { text: "Politique d'archivage : fiscal 6 ans, comptable 10 ans.", ok: true },
              { text: "DPA / Accord de traitement RGPD — rôles, sous-traitants, mesures techniques.", ok: true },
            ]}
            link="Voir la page sécurité"
            linkHref="/security"
            illustration={<ArchiveIllustration />}
            reverse
            overlayCards={
              <>
                <motion.div
                  className="absolute -bottom-5 -left-5 px-4 py-3 rounded-2xl"
                  style={{
                    background: "white",
                    border: "1px solid #e2e8f0",
                    boxShadow: "0 16px 48px rgba(0,0,0,0.12)",
                  }}
                  initial={{ opacity: 0, y: -12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 1 }}
                  whileHover={{ y: 3 }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-9 h-9 rounded-xl flex items-center justify-center"
                      style={{ background: "linear-gradient(135deg, #059669, #10b981)" }}
                    >
                      <Shield size={16} className="text-white" />
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400">Archivage</p>
                      <p className="text-[13px] font-bold text-slate-900">10 ans compta</p>
                    </div>
                  </div>
                </motion.div>
              </>
            }
          />
        </div>
      </div>
    </section>
  );
}
