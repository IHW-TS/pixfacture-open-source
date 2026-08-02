export type InvoiceTemplateKey = "classic" | "graphite" | "ivory";

export type InvoiceTemplateOptions = {
  show_delivery_address: boolean;
  show_purchase_order_number: boolean;
  show_note: boolean;
};

export const DEFAULT_TEMPLATE_KEY: InvoiceTemplateKey = "classic";

export const DEFAULT_TEMPLATE_OPTIONS: InvoiceTemplateOptions = {
  show_delivery_address: true,
  show_purchase_order_number: true,
  show_note: true,
};

export const INVOICE_TEMPLATES: Array<{
  key: InvoiceTemplateKey;
  label: string;
  description: string;
}> = [
  { key: "classic", label: "Classique", description: "Bleu sobre, mise en page standard." },
  { key: "graphite", label: "Graphite", description: "Contraste neutre, style gris foncé." },
  { key: "ivory", label: "Ivoire", description: "Chaud et lumineux, accent ambre." },
];

export const normalizeTemplateKey = (value?: string | null): InvoiceTemplateKey => {
  const raw = (value || "").trim().toLowerCase();
  if (raw === "graphite" || raw === "ivory" || raw === "classic") return raw;
  return DEFAULT_TEMPLATE_KEY;
};

export const normalizeTemplateOptions = (value?: Partial<Record<keyof InvoiceTemplateOptions, unknown>> | null) => {
  const opts: InvoiceTemplateOptions = { ...DEFAULT_TEMPLATE_OPTIONS };
  if (!value) return opts;
  (Object.keys(DEFAULT_TEMPLATE_OPTIONS) as Array<keyof InvoiceTemplateOptions>).forEach((key) => {
    if (value[key] !== undefined) opts[key] = Boolean(value[key]);
  });
  return opts;
};
