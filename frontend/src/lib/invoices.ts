export type InvoiceLineInput = {
  product_name: string;
  quantity: number;
  unit_price: number;
  vat_rate: number;
  vat_category?: string;
};

export function computeDueDate(paymentTerms: string, base: Date = new Date()) {
  let days = 30;
  const match = paymentTerms?.match(/(\d+)/);
  if (match) days = parseInt(match[1]);
  let d = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  if (/fin de mois|fdm/i.test(paymentTerms || "")) {
    d = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  }
  return d;
}

export function computeTotals(lines: InvoiceLineInput[]) {
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const vat = lines.reduce((s, l) => s + l.quantity * l.unit_price * (l.vat_rate / 100), 0);
  return { subtotal, vat, total: subtotal + vat };
}

export function validateLines(lines: InvoiceLineInput[]) {
  return lines.map((l) => {
    const errs: string[] = [];
    if (!l.product_name) errs.push("Désignation manquante");
    if (l.quantity <= 0) errs.push("Quantité doit être > 0");
    const vatMissing = l.vat_rate === undefined || l.vat_rate === null || Number.isNaN(Number(l.vat_rate));
    if (vatMissing) errs.push("Taux de TVA manquant");
    if (l.unit_price < 0) errs.push("PU HT négatif");
    return errs;
  });
}
