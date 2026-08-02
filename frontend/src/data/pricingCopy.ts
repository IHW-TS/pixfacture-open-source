import { TRIAL_DAYS } from "@/lib/billingConstants";
import { complianceTimeline, formatIsoDateShortFr, formatYearRange } from "@/lib/complianceTimeline";

const timelineRange = formatYearRange(
  complianceTimeline.einvoicing.reception,
  complianceTimeline.einvoicing.emission_pme_micro,
  "–",
);
const receptionShort = formatIsoDateShortFr(complianceTimeline.einvoicing.reception);

export const PRICING_COPY = {
  hero: {
    eyebrow: "Tarifs",
    updatedPrefix: "MAJ :",
    supporting: `Des plans clairs pour facturer, exporter et vous préparer à la réforme ${timelineRange || "2026–2027"}.`,
    chips: [
      { id: "trial", label: `Essai ${TRIAL_DAYS} jours` },
      { id: "flex", label: "Plans évolutifs" },
      { id: "sources", label: "Sources officielles" },
      { id: "support", label: "Support client" },
    ],
    legalNote:
      "PA = plateforme agréée (ex‑PDP). La transmission réglementaire s’effectue via une PA sous contrat/mandat.",
    ctas: {
      primary: "Commencer",
      primaryHint: `Créer un compte • essai ${TRIAL_DAYS} jours`,
      secondary: "Comparer les plans",
      platforms: "Plateformes compatibles →",
    },
    stats: {
      facturxLabel: "Factur‑X",
      calendarLabel: "Calendrier",
      calendarHint: `Réception : ${receptionShort}`,
    },
  },

  notices: {
    subscriptionRequired: {
      title: "Abonnement requis.",
      body: "Choisissez un plan pour activer votre espace.",
    },
    billingUnavailable: {
      title: "Souscription en ligne temporairement indisponible.",
      body: "Contactez-nous pour activer un plan.",
    },
    devFallback: {
      title: "Tarifs de test.",
      body: "Ces tarifs sont affichés uniquement dans l'environnement local.",
    },
    pricingUnavailable: {
      title: "Tarifs indisponibles.",
      body: "Contactez‑nous pour un devis.",
    },
  },
  archivingNote:
    "Conservation documentaire à paramétrer selon vos obligations, votre contrat et vos procédures internes.",

  plans: {
    heading: "Des plans adaptés à votre volume",
    subheading: `Commencez par une période d’essai de ${TRIAL_DAYS} jours, puis activez le plan qui correspond à votre usage.`,
    billingToggle: {
      ariaLabel: "Période de facturation",
      monthly: "Mensuel",
      yearly: "Annuel",
      yearlyBadge: "Économisez 2 mois",
      yearlyHelper: "Annuel : économisez 2 mois.",
    },
    cards: {
      starter: {
        name: "Starter",
        tagline: "Facturation classique",
        highlights: [
          "Factures PDF professionnelles",
          "Clients, articles & TVA",
          "Exports CSV / journal",
          "Achats et paiements réservés au plan Pro",
          "Préparation e-facturation réservée au plan Pro",
        ],
        cta: "Choisir Starter",
        ctaHint: "Idéal pour démarrer.",
        compareLink: "Comparer Starter",
      },
      pro: {
        name: "Pro",
        badge: "Recommandé",
        tagline: "Préparation e-facturation",
        highlights: [
          "Tout Starter",
          "Achats fournisseurs et suivi des paiements",
          "Factur‑X lorsque les données passent les contrôles requis",
          "50 jetons réservés, puis crédités après activation et disponibilité du stock",
          "Packs disponibles après activation opérationnelle",
          "1 société / jusqu'à 3 utilisateurs",
          "Préparation export ou connecteur PA selon configuration",
        ],
        cta: "Choisir Pro",
        ctaHint: "Pour préparer l’e-facturation et les connecteurs.",
        compareLink: "Comparer Pro",
      },
      enterprise: {
        name: "Volume",
        tagline: "Besoin spécifique",
        highlights: [
          "Tout Pro inclus",
          "Cadrage volume et intégrations",
          "Accompagnement au démarrage",
          "Contrat et support adaptés",
          "Options avancées après validation",
        ],
        cta: "Nous contacter",
        ctaHint: "Périmètre, volume, intégrations.",
        compareLink: "Comparer Volume",
      },
    },
    login: {
      label: "Déjà client ?",
      cta: "Se connecter",
    },
  },

  comparison: {
    id: "comparatif",
    title: "Comparer les fonctionnalités",
    subtitle: "Recherchez une fonctionnalité ou affichez uniquement les différences.",
    searchPlaceholder: "Rechercher (Factur‑X, canal public, export…)",
    diffOnly: "Différences uniquement",
    reset: "Réinitialiser",
  },

  faq: {
    title: "Questions fréquentes",
    subtitle: "Besoin de clarifier un point avant de choisir ?",
    items: [
      {
        q: "Y a‑t‑il une période d’essai ?",
        a: `À l’inscription, vous disposez d’un essai Pro de ${TRIAL_DAYS} jours, limité aux brouillons et prévisualisations. L’émission définitive, l’envoi d’emails aux clients et les transmissions nécessitent un abonnement actif.`,
      },
      {
        q: "Puis‑je changer de plan plus tard ?",
        a: "Oui. Vous pouvez passer d’un plan à l’autre selon l’évolution de vos besoins (volume, multi‑utilisateurs, connecteurs).",
      },
      {
        q: "Êtes‑vous une plateforme agréée (PA, ex‑PDP) ?",
        a: "Non. Nous sommes un logiciel de facturation B2B. La transmission réglementaire se fait via une plateforme agréée (PA) sous contrat/mandat, lorsque vous l’activez.",
      },
      {
        q: "Comment fonctionne le connecteur vers une plateforme agréée (PA) ?",
        a: "Le plan Pro peut préparer une connexion à une PA via un connecteur partenaire, selon disponibilité, contrat, mandat et configuration. L’abonnement seul ne crée pas le mandat : l’entreprise doit confirmer l’activation dans l’espace e-facturation.",
      },
      {
        q: "Quels formats de facture sont pris en charge ?",
        a: "Le PDF classique est disponible avec Starter. Les exports structurés CII/UBL et Factur‑X nécessitent le plan Pro, les contrôles requis et la configuration applicable.",
      },
      {
        q: "Qu’est‑ce qu’un jeton de transmission ?",
        a: "Un jeton correspond à une transmission consommée en mode connecté. Les 50 jetons Pro sont réservés à la souscription, puis crédités après activation et disponibilité du stock ; leur usage et l'achat de packs exigent un connecteur opérationnel.",
      },
      {
        q: "Le canal public (B2G) est‑il pris en charge ?",
        a: "Le parcours B2G peut être préparé avec Pro. Son utilisation exige les identifiants, paramètres et contrôles d’activation requis ; il reste distinct du B2B.",
      },
      {
        q: "Où trouver les sources officielles sur la réforme ?",
        a: `Nous indiquons les liens vers les pages officielles (calendrier, spécifications B2B, liste des plateformes agréées) dans la section “Réforme ${timelineRange || "2026–2027"}”.`,
      },
    ],
    footerCta: {
      label: "Vous avez un cas particulier ?",
      link: "Parler à un expert →",
      href: "/contact",
    },
  },

  reform: {
    summary: `Réforme ${timelineRange || "2026–2027"} : calendrier et points clés`,
    intro:
      "Le calendrier et les obligations peuvent évoluer : nous citons les sources officielles et datons nos mises à jour.",
    cards: {
      mentionsTitle: "Mentions à prévoir (exemples)",
      mentionsItems: [
        "SIREN du client",
        "Adresse de livraison (si différente)",
        "Nature de l’opération : biens / services / mixte",
        "TVA sur les débits",
      ],
      platformsTitle: "Plateformes agréées (PA) & PPF",
      platformsItems: [
        `Réception obligatoire à partir du ${receptionShort}`,
        "Émission & e‑reporting : progressif",
        "Consulter la liste officielle des plateformes agréées",
      ],
    },
    sourcesPrefix: "Sources officielles :",
  },
} as const;
