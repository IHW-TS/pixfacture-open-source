import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Plus, Minus, ExternalLink } from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";

const categories = [
  {
    label: "Réforme 2026–2027",
    slug: "reforme",
    faqs: [
      {
        q: "Qu'est-ce que la réforme de la facturation électronique 2026–2027 ?",
        a: "À partir de 2026, toutes les entreprises françaises assujetties à la TVA devront être capables de recevoir des factures électroniques. L'émission progressive démarre au 1er septembre 2026 pour les grandes entreprises et ETI, puis en 2027 pour les PME et micro-entreprises. L'e-reporting suit le même calendrier.",
      },
      {
        q: "Qu'est-ce qu'une facture électronique (au sens de la réforme) ?",
        a: "Une \"facture électronique\" au sens réglementaire n'est pas un PDF scanné ou envoyé par email : elle doit être structurée (UBL, CII, ou format mixte Factur‑X) et transiter via une plateforme agréée (PA, ex‑PDP) immatriculée. Un PDF joint par email ne satisfait pas l'obligation e-invoicing.",
      },
      {
        q: "Quelles sont les 4 nouvelles mentions obligatoires ?",
        a: "La réforme impose 4 nouvelles mentions : 1) SIREN du client (si client = entreprise), 2) Adresse de livraison si différente de l'adresse de facturation, 3) Nature de l'opération : biens / services / mixte, 4) Mention «Option pour le paiement de la taxe d'après les débits» si applicable.",
      },
      {
        q: "Quelles données dois-je collecter dès maintenant ?",
        a: "Pour préparer la réforme : SIREN/SIRET, adresse complète, numéro de TVA intracommunautaire, nature de l'opération (biens/services/mixte), adresse de livraison si différente, option TVA sur les débits (si applicable), et autres champs selon les spécifications en vigueur (référentiel DGFiP).",
      },
      {
        q: "Où trouver les sources officielles sur la réforme ?",
        a: "Les sources officielles sont : le calendrier officiel sur economie.gouv.fr, les spécifications externes B2B sur impots.gouv.fr, et la liste officielle des plateformes agréées (PA, ex‑PDP). Ces sources font foi et peuvent évoluer.",
      },
    ],
  },
  {
    label: "Factur‑X & formats",
    slug: "formats",
    faqs: [
      {
        q: "Factur‑X, c'est quoi ?",
        a: "Un PDF avec des données structurées embarquées (format mixte PDF/A-3b + XML/CII), compatible avec la logique de facture électronique. Il combine la lisibilité d'un PDF et les données structurées (XML/CII) requises pour la transmission réglementaire.",
      },
      {
        q: "Quels formats de facture sont pris en charge ?",
        a: "PDF, Factur‑X (PDF/A-3b + XML/CII), UBL et CII selon le plan et la configuration. Nous nous basons sur les spécifications officielles (DGFiP — spécifications externes B2B) et mettons à jour les contrôles/exports au fil des évolutions réglementaires.",
      },
      {
        q: "Comment fonctionnent les jetons de transmission ?",
        a: "Les transmissions réglementaires connectées peuvent consommer des jetons selon le connecteur activé. Le solde est visible dans l'abonnement et les recharges se font par packs ponctuels.",
      },
    ],
  },
  {
    label: "Plateformes agréées (PA) & connecteurs",
    slug: "plateformes",
    faqs: [
      {
        q: "Êtes‑vous une plateforme agréée (PA, ex‑PDP) ?",
        a: "Non. Nous sommes un logiciel de facturation B2B. La transmission réglementaire se fait via une plateforme agréée (PA, ex‑PDP) sous contrat/mandat, lorsqu'un connecteur est disponible et actif pour votre espace. Nous ne sommes pas immatriculés comme PA par l'État.",
      },
      {
        q: "Comment fonctionne le connecteur vers une plateforme agréée (PA) ?",
        a: "Le plan Pro permet de préparer la plateforme partenaire selon contrat, mandat et configuration. L'app suit les étapes et Pro attribue 50 jetons une seule fois, puis les transmissions supplémentaires nécessitent des packs.",
      },
      {
        q: "Qu'est‑ce qu'un mandat et à quoi sert‑il ?",
        a: "Le mandat autorise notre SaaS à opérer, via la plateforme agréée (PA), certaines actions en votre nom, notamment la réception des factures et la gestion des statuts. Il est préparé et suivi depuis l'app après confirmation explicite, puis les fonctionnalités connectées deviennent disponibles lorsqu'un mandat est actif.",
      },
      {
        q: "Chorus Pro (B2G) est‑il pris en charge ?",
        a: "Oui, si configuré (identifiants PISTE et paramètres requis). B2G via Chorus Pro possible selon votre configuration. Le cas d'usage B2G reste distinct du B2B e-invoicing.",
      },
      {
        q: "L'e‑reporting est‑il inclus ?",
        a: "L'e‑reporting est en préparation. Mode export possible ; automatisation prévue via connecteur partenaire selon votre périmètre (B2C / international / paiements). L'e-reporting suit le même calendrier que l'e-invoicing (via PA ou export selon périmètre).",
      },
    ],
  },
  {
    label: "Plans & tarifs",
    slug: "tarifs",
    faqs: [
      {
        q: "Y a‑t‑il un essai gratuit ?",
        a: "Oui. Vous pouvez démarrer en mode export (Factur‑X/PDF/CSV) sans engagement. Consultez la page tarifs pour les détails de chaque plan et les conditions d'activation du mode connecté.",
      },
      {
        q: "Puis‑je changer de plan plus tard ?",
        a: "Oui. Vous pouvez passer d'un plan à l'autre selon l'évolution de vos besoins (volume, multi‑utilisateurs, connecteurs). La montée en plan active les fonctionnalités correspondantes sans perte de données.",
      },
      {
        q: "Quelle est la différence entre mode export et mode connecté ?",
        a: "En mode export, vous générez vos factures (PDF, Factur‑X) depuis le logiciel et vous les transmettez vous-même via votre PA ou le canal de votre choix. En mode connecté (plan Pro), le logiciel transmet automatiquement via un connecteur PA partenaire activé par notre SaaS, sous mandat.",
      },
    ],
  },
  {
    label: "Sécurité & conformité légale",
    slug: "securite",
    faqs: [
      {
        q: "Est-ce que le SaaS garantit ma conformité légale ?",
        a: "Non. Le service ne constitue pas un conseil fiscal/juridique. Il fournit les outils techniques (Factur‑X, contrôles, connecteurs) pour faciliter la conformité, mais la conformité complète dépend de votre situation (TVA, opérations, secteurs), de votre configuration et des textes applicables.",
      },
      {
        q: "Où sont hébergées mes données ?",
        a: "Les données sont hébergées dans l'UE/EEE selon la configuration de l'instance. Chiffrement en transit (TLS), gestion des accès par rôles et double authentification disponible. Voir la page sécurité pour le détail complet.",
      },
      {
        q: "Quels champs sont requis dans le profil entreprise ?",
        a: "Minimum requis : SIRET de l'émetteur (pour l'identification légale) et numéro de TVA intracommunautaire (ou mention d'exonération si applicable). Recommandé : IBAN si paiement par virement. Ces informations servent à produire des factures complètes (mentions obligatoires) et à préparer vos échanges B2B.",
      },
    ],
  },
];

function FaqItem({ faq }: { faq: { q: string; a: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div
      className="border rounded-xl overflow-hidden bg-white"
      style={{ borderColor: "rgba(15,23,42,0.08)" }}
      animate={{ borderColor: open ? "rgba(29,78,216,0.3)" : "rgba(15,23,42,0.08)" }}
      transition={{ duration: 0.25 }}
    >
      <motion.button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-4 p-5 text-left bg-transparent border-none cursor-pointer"
        style={{ backgroundColor: "rgba(0,0,0,0)" }}
        whileHover={{ backgroundColor: "rgba(248,250,252,1)" }}
      >
        <span className="text-[14px] font-medium text-slate-900 leading-snug">{faq.q}</span>
        <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors ${open ? "bg-blue-700 text-white" : "bg-slate-100 text-slate-500"}`}>
          {open ? <Minus size={13} /> : <Plus size={13} />}
        </div>
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <p className="px-5 pb-5 text-[13px] text-slate-500 leading-[1.75]">{faq.a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function FaqPage() {
  const [activeCategory, setActiveCategory] = useState("reforme");
  const current = categories.find((c) => c.slug === activeCategory) ?? categories[0];

  return (
    <LegalLayout>
      <div className="max-w-[1120px] mx-auto px-6 pb-24">
        {/* Header */}
        <div className="py-12 border-b border-slate-100 mb-10">
          <span className="text-[11px] uppercase tracking-widest text-blue-700 mb-3 block">FAQ</span>
          <h1 className="text-[32px] md:text-[40px] font-bold text-slate-900 leading-tight tracking-tight mb-3">
            Questions fréquentes
          </h1>
          <p className="text-[16px] text-slate-500 max-w-xl">
            Réforme 2026–2027, Factur‑X, plateformes agréées (PA), plans et sécurité. Besoin de clarifier un point avant de choisir ?
          </p>
        </div>

        <div className="grid lg:grid-cols-[220px_1fr] gap-10">
          {/* Sidebar */}
          <aside className="hidden lg:block">
            <div className="sticky top-24">
              <p className="text-[11px] uppercase tracking-widest text-slate-400 mb-3">Catégories</p>
              <nav className="flex flex-col gap-1">
                {categories.map((c) => (
                  <button
                    key={c.slug}
                    onClick={() => setActiveCategory(c.slug)}
                    className={`text-left text-[13px] py-2 px-3 rounded-lg bg-transparent border-none cursor-pointer transition-colors ${activeCategory === c.slug ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:text-slate-800"}`}
                  >
                    {c.label}
                  </button>
                ))}
              </nav>
            </div>
          </aside>

          {/* Mobile tabs */}
          <div className="lg:hidden flex gap-2 overflow-x-auto pb-2 mb-4 -mx-6 px-6">
            {categories.map((c) => (
              <button
                key={c.slug}
                onClick={() => setActiveCategory(c.slug)}
                className={`shrink-0 text-[12px] px-3 py-1.5 rounded-full border-none cursor-pointer transition-colors ${activeCategory === c.slug ? "bg-blue-700 text-white" : "bg-slate-100 text-slate-600"}`}
              >
                {c.label}
              </button>
            ))}
          </div>

          {/* FAQs */}
          <div>
            <h2 className="text-[20px] font-bold text-slate-900 mb-6">{current.label}</h2>
            <div className="flex flex-col gap-3">
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeCategory}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.3 }}
                  className="flex flex-col gap-3"
                >
                  {current.faqs.map((faq, i) => (
                    <FaqItem key={i} faq={faq} />
                  ))}
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Sources */}
            <div className="mt-10 pt-6 border-t border-slate-100">
              <p className="text-[12px] text-slate-400 mb-3">
                Les informations sur la réforme sont fournies à titre informatif et peuvent évoluer. Références officielles :
              </p>
              <div className="flex flex-col gap-2">
                {[
                  { label: "Calendrier officiel — economie.gouv.fr", href: "https://www.economie.gouv.fr/tout-savoir-sur-la-facturation-electronique-pour-les-entreprises" },
                  { label: "Spécifications externes B2B (DGFiP) — impots.gouv.fr", href: "https://www.impots.gouv.fr/specifications-externes-b2b" },
                  { label: "Liste officielle des plateformes agréées (PA, ex‑PDP)", href: "https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees" },
                ].map((s) => (
                  <a key={s.href} href={s.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2">
                    {s.label} <ExternalLink size={11} />
                  </a>
                ))}
              </div>
              <p className="text-[12px] text-slate-400 mt-4">
                Le service ne constitue pas un conseil fiscal/juridique.{" "}
                <a href="/contact" className="text-blue-700 underline underline-offset-2">Vous avez un cas particulier ? Parler à un expert →</a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </LegalLayout>
  );
}
