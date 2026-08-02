"use client";
import { useId, useState } from "react";
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
        a: "Au 1er septembre 2026, toutes les entreprises concernées devront pouvoir recevoir des factures électroniques ; les grandes entreprises et ETI devront aussi en émettre. L'obligation d'émission s'appliquera aux PME et micro-entreprises au 1er septembre 2027. L'e-reporting suit ce calendrier progressif.",
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
        a: "Un format mixte qui combine un PDF lisible et des données structurées XML/CII. Le profil exact, dont PDF/A, dépend du plan et de la configuration de validation activée.",
      },
      {
        q: "Quels formats de facture sont pris en charge ?",
        a: "PDF et Factur‑X/CII selon le plan et la configuration. UBL est disponible uniquement si l’export est activé sur l’instance; le niveau PDF/A-3b dépend de la validation configurée.",
      },
      {
        q: "Comment fonctionnent les jetons de transmission ?",
        a: "Une transmission réglementaire connectée peut consommer un jeton selon le connecteur activé. Dans l'app, l'accès opérationnel à ces zones et aux recharges est réservé au plan Pro.",
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
        a: "Le plan Pro permet de préparer la connexion à une plateforme partenaire selon contrat, mandat et configuration. L'abonnement seul ne crée pas le mandat : un représentant habilité de l'entreprise doit confirmer l'activation. Les 50 jetons sont réservés à la souscription, puis crédités après activation et disponibilité du stock ; leur usage et les recharges exigent un connecteur opérationnel.",
      },
      {
        q: "Qu'est‑ce qu'un mandat et à quoi sert‑il ?",
        a: "Le mandat autorise certaines opérations via la plateforme agréée (PA). Seul un représentant habilité peut l'accepter. Sa préparation dans l'app ne vaut ni signature ni activation : les fonctions connectées ne deviennent disponibles qu'après confirmation du mandat, du contrat, de la vérification d'entreprise et de la configuration opérationnelle.",
      },
      {
        q: "Le canal public (B2G) est‑il pris en charge ?",
        a: "Le canal Chorus Pro B2G est réservé au plan Pro et n'est utilisable que si la configuration PISTE/Chorus requise est active. Il reste distinct du circuit B2B via plateforme agréée.",
      },
      {
        q: "L'e‑reporting est‑il inclus ?",
        a: "L'e-reporting est proposé en beta Pro selon périmètre. L'export est disponible ; l'envoi connecté dépend de la plateforme agréée, du mandat, de la configuration et des jetons.",
      },
    ],
  },
  {
    label: "Plans & tarifs",
    slug: "tarifs",
    faqs: [
      {
        q: "Y a‑t‑il un essai gratuit ?",
        a: "Oui. L’essai Pro dure 7 jours, sans carte bancaire. Il permet les brouillons et prévisualisations, sans émission définitive, email client ni transmission.",
      },
      {
        q: "Puis‑je changer de plan plus tard ?",
        a: "Oui. Vous pouvez passer de Starter à Pro pour préparer l'e-facturation, sans perte de données. Le mode connecté exige ensuite un contrat, un mandat et une configuration opérationnelle avec la plateforme agréée (PA).",
      },
      {
        q: "Quelle est la différence entre mode export et mode connecté ?",
        a: "En mode export, vous générez vos factures depuis le logiciel et vous les transmettez vous-même. Le plan Pro permet de préparer le mode connecté ; son utilisation exige séparément un contrat, un mandat et une configuration opérationnelle avec une plateforme agréée (PA).",
      },
      {
        q: "Comment fonctionnent les jetons de transmission ?",
        a: "Le plan Pro attribue 50 jetons une seule fois lors de sa première activation effective. Il n'y a pas de recharge mensuelle automatique. Les jetons et l'achat de packs restent indisponibles tant qu'aucun connecteur n'est opérationnel.",
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
  const panelId = useId();
  return (
    <motion.div
      className="border rounded-xl overflow-hidden bg-white"
      style={{ borderColor: "rgba(15,23,42,0.08)" }}
      animate={{ borderColor: open ? "rgba(29,78,216,0.3)" : "rgba(15,23,42,0.08)" }}
      transition={{ duration: 0.25 }}
    >
      <motion.button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full flex items-center justify-between gap-4 p-5 text-left bg-transparent border-none cursor-pointer"
        style={{ backgroundColor: "rgba(0,0,0,0)" }}
        whileHover={{ backgroundColor: "rgba(248,250,252,1)" }}
      >
        <span className="text-[14px] font-medium text-slate-900 leading-snug">{faq.q}</span>
        <div
          className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors ${open ? "bg-blue-700 text-white" : "bg-slate-100 text-slate-500"}`}
        >
          {open ? <Minus size={13} /> : <Plus size={13} />}
        </div>
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            role="region"
            aria-label={faq.q}
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
      <div className="max-w-[1240px] mx-auto px-6 md:px-8 pb-24">
        {/* Header */}
        <div className="mb-10 border-b border-slate-100 py-16">
          <div className="mx-auto flex max-w-[820px] flex-col items-center gap-6 text-center">
            <span className="inline-block text-[11px] font-semibold uppercase tracking-[0.12em] leading-none text-blue-700">
              FAQ
            </span>
            <h1 className="max-w-[780px] text-4xl font-bold leading-[1.08] tracking-tight text-slate-900 md:text-5xl">
              Questions fréquentes
            </h1>
            <p className="mx-auto max-w-[760px] text-[17px] leading-relaxed text-slate-600">
              Réforme 2026–2027, Factur‑X, plateformes agréées (PA), plans et sécurité. Besoin de clarifier un point
              avant de choisir ?
            </p>
          </div>
        </div>

        <div className="grid lg:grid-cols-[220px_1fr] gap-10">
          {/* Sidebar */}
          <aside className="hidden lg:block">
            <div className="sticky top-24">
              <p className="text-[11px] uppercase tracking-widest text-slate-600 mb-3">Catégories</p>
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
              <p className="text-[12px] text-slate-600 mb-3">
                Les informations sur la réforme sont fournies à titre informatif et peuvent évoluer. Références
                officielles :
              </p>
              <div className="flex flex-col gap-2">
                {[
                  {
                    label: "Calendrier officiel — economie.gouv.fr",
                    href: "https://www.impots.gouv.fr/professionnel/je-passe-la-facturation-electronique",
                  },
                  {
                    label: "Spécifications externes B2B (DGFiP) — impots.gouv.fr",
                    href: "https://www.impots.gouv.fr/specifications-externes-b2b",
                  },
                  {
                    label: "Liste officielle des plateformes agréées (PA, ex‑PDP)",
                    href: "https://www.impots.gouv.fr/je-consulte-la-liste-des-plateformes-agreees",
                  },
                ].map((s) => (
                  <a
                    key={s.href}
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[13px] text-blue-700 underline underline-offset-2"
                  >
                    {s.label} <ExternalLink size={11} />
                  </a>
                ))}
              </div>
              <p className="text-[12px] text-slate-600 mt-4">
                Le service ne constitue pas un conseil fiscal/juridique.{" "}
                <a href="/contact" className="text-blue-700 underline underline-offset-2">
                  Vous avez un cas particulier ? Parler à un expert →
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </LegalLayout>
  );
}
