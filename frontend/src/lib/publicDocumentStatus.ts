export type PublicDocumentKind = "invoice" | "quote";

const INVOICE_STATUS_LABELS: Record<string, string> = {
  draft: "Brouillon",
  issued: "Émise",
  sent: "Envoyée",
  overdue: "En retard",
  partial: "Partiellement réglée",
  paid: "Payée",
  canceled: "Annulée",
  cancelled: "Annulée",
  refunded: "Remboursée",
  partially_refunded: "Partiellement remboursée",
};

const QUOTE_STATUS_LABELS: Record<string, string> = {
  draft: "Brouillon",
  sent: "Envoyé",
  accepted: "Accepté",
  rejected: "Refusé",
  invoiced: "Facturé",
  expired: "Expiré",
  canceled: "Annulé",
  cancelled: "Annulé",
};

const normalizeStatus = (status: unknown) => (typeof status === "string" ? status.trim().toLowerCase() : "");

export function publicDocumentStatusLabel(status: unknown, kind: PublicDocumentKind) {
  const normalized = normalizeStatus(status);
  const labels = kind === "quote" ? QUOTE_STATUS_LABELS : INVOICE_STATUS_LABELS;
  return labels[normalized] || "Statut en cours";
}
