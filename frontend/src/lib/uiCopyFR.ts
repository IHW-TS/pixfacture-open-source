import { PLATFORM_LABEL_LONG } from "@/lib/terminology";

export type BillingStatus = "none" | "incomplete" | "trialing" | "active" | "past_due" | "unpaid" | "canceled";

export const UI_COPY_FR = {
  legalAcceptanceModal: {
    title: "Avant de continuer vers le paiement",
    intro:
      "Pour activer votre abonnement, vous devez accepter les documents ci-dessous. Vous pourrez les consulter à tout moment depuis le pied de page du site et dans l’application.",
    documentsTitle: "Documents à accepter",
    checkboxTerms: (termsVersion: string) =>
      `J’ai lu et j’accepte les Conditions Générales (CGV/CGU) — version ${termsVersion}.`,
    checkboxDpa: (dpaVersion: string) =>
      `J’ai lu et j’accepte l’Accord de traitement des données (DPA) — version ${dpaVersion}.`,
    einvoicingTitle: "Important — e‑facturation (France)",
    einvoicingBody: (companyName: string) =>
      `${companyName} n’est pas une ${PLATFORM_LABEL_LONG}. La transmission réglementaire de factures électroniques (émission/réception, statuts, e‑reporting) s’effectue via une ${PLATFORM_LABEL_LONG} contractualisée (la vôtre ou celle d’un partenaire). Selon l’offre et les modules activés, l’application permet l’export de factures structurées (Factur‑X / EN16931) et peut se raccorder à une ${PLATFORM_LABEL_LONG} via connecteur et mandat.`,
    ctaContinue: "Continuer vers le paiement (Stripe)",
    ctaCancel: "Annuler",
    footer:
      "En cliquant sur « Continuer vers le paiement », vous serez redirigé vers le portail de paiement pour finaliser votre abonnement. Vous pourrez gérer votre abonnement (factures, moyen de paiement, résiliation) depuis « Abonnement ».",
    errorMustAccept: "Pour continuer, vous devez accepter les CGV/CGU et la DPA.",
  },

  billingPaywall: {
    title: "Abonnement requis",
    subtitle: "Cette fonctionnalité nécessite un abonnement actif.",
    body: "Vous pouvez toujours accéder à vos données et les exporter. Les actions d’édition et d’envoi sont désactivées tant que l’abonnement n’est pas actif.",
    tipJustPaid:
      "Vous venez de payer ? La synchronisation peut prendre quelques secondes. Cliquez sur « Actualiser l’état ».",
    ctaCheckoutPro: "Passer Pro",
    ctaChoosePlan: "Choisir un abonnement",
    ctaManage: "Gérer mon abonnement",
    ctaRefresh: "Actualiser l’état",
    ctaSupport: "Contacter le support",
    smallPrint:
      "Si le problème persiste après actualisation, vérifiez le paiement dans Stripe ou contactez le support.",
  },

  billingBanner: {
    trialing: (trialEndLocal: string) =>
      `Essai en cours — jusqu’au ${trialEndLocal}. Vous pouvez gérer votre abonnement depuis « Abonnement ».`,
    active: "Abonnement actif.",
    cancelAtPeriodEnd: (periodEndLocal: string) =>
      `Abonnement résilié — accès actif jusqu’au ${periodEndLocal}. Vous pouvez réactiver à tout moment depuis « Abonnement ».`,
    pastDue: (daysLeft: number) => {
      const unit = daysLeft === 1 ? "jour" : "jours";
      return `Paiement en échec — nous n’avons pas pu encaisser votre abonnement. Les fonctionnalités passeront en lecture seule dans ${daysLeft} ${unit} si le paiement n’est pas mis à jour.`;
    },
    unpaid:
      "Abonnement suspendu — accès en lecture seule. Mettez à jour votre moyen de paiement pour réactiver l’abonnement.",
    canceled:
      "Abonnement inactif — certaines fonctionnalités sont indisponibles. Choisissez un abonnement pour réactiver l’accès.",
    ctaUpdatePayment: "Mettre à jour le paiement",
    ctaOpenBilling: "Ouvrir la facturation",
    ctaReactivate: "Réactiver",
    ctaRefresh: "Actualiser",
  },
} as const;
