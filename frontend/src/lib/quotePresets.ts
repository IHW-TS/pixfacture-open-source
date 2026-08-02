export type QuoteLinePreset = {
  product_name: string;
  quantity: number;
  unit_price: number;
  vat_rate: number;
  vat_category: string;
  unit_code: string;
  exemption_reason_code?: string | null;
};

export type QuotePreset = {
  id: string;
  label: string;
  description: string;
  /**
   * Default quote validity duration in days (starting today).
   */
  validUntilDays: number;
  /**
   * Optional default note inserted in the quote.
   */
  note?: string;
  /**
   * Optional default payment terms inserted in the quote (B2B-friendly).
   */
  payment_terms?: string;
  lines: QuoteLinePreset[];
};

/**
 * Built-in quote presets (MVP). These are not meant to be perfect accounting templates,
 * but to speed-up the "first quote" moment and to reduce blank-page anxiety.
 *
 * You can add tenant-custom presets later (DB) without breaking the UI: keep `id` stable.
 */
export const QUOTE_PRESETS: QuotePreset[] = [
  {
    id: "blank",
    label: "Vierge",
    description: "Un devis vide (à compléter).",
    validUntilDays: 30,
    lines: [{ product_name: "", quantity: 1, unit_price: 0, vat_rate: 20, vat_category: "S", unit_code: "C62" }],
  },
  {
    id: "service",
    label: "Prestation",
    description: "Une prestation simple (forfait).",
    validUntilDays: 30,
    payment_terms: "Paiement à 30 jours.",
    lines: [
      { product_name: "Prestation", quantity: 1, unit_price: 500, vat_rate: 20, vat_category: "S", unit_code: "C62" },
    ],
  },
  {
    id: "saas_monthly",
    label: "SaaS mensuel",
    description: "Abonnement mensuel (SaaS).",
    validUntilDays: 15,
    payment_terms: "Paiement mensuel d’avance.",
    lines: [
      {
        product_name: "Abonnement SaaS - Mensuel",
        quantity: 1,
        unit_price: 59,
        vat_rate: 20,
        vat_category: "S",
        unit_code: "MON",
      },
    ],
  },
  {
    id: "maintenance_annual",
    label: "Maintenance annuelle",
    description: "Maintenance/support annuel.",
    validUntilDays: 30,
    payment_terms: "Paiement à 30 jours.",
    lines: [
      {
        product_name: "Maintenance / support annuel",
        quantity: 1,
        unit_price: 300,
        vat_rate: 20,
        vat_category: "S",
        unit_code: "ANN",
      },
    ],
  },
  {
    id: "deposit_30",
    label: "Acompte 30%",
    description: "Acompte (à ajuster) + solde à livraison.",
    validUntilDays: 30,
    note: "Acompte de 30% à la commande. Solde à la livraison / mise en production.",
    payment_terms: "Acompte à la commande.",
    lines: [
      {
        product_name: "Acompte (30%)",
        quantity: 1,
        unit_price: 0,
        vat_rate: 20,
        vat_category: "S",
        unit_code: "C62",
      },
      {
        product_name: "Solde (70%)",
        quantity: 1,
        unit_price: 0,
        vat_rate: 20,
        vat_category: "S",
        unit_code: "C62",
      },
    ],
  },
];

export function getQuotePreset(presetId: string | null | undefined): QuotePreset | null {
  const id = (presetId || "").trim();
  if (!id) return null;
  return QUOTE_PRESETS.find((p) => p.id === id) || null;
}
