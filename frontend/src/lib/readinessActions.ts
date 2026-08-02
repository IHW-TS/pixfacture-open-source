export type ReadinessDangerLevel = "none" | "info" | "warning" | "danger" | "success";

export type ReadinessNextAction = {
  kind: string;
  label: string;
  reason: string;
  danger_level: ReadinessDangerLevel;
  autoFixable: boolean;
  apiAction?: string | null;
};

type ResolveInvoiceReadinessInput = {
  invoice?: any;
  readiness?: any;
  canFollowup?: boolean;
};

type ResolveQuoteReadinessInput = {
  quote?: any;
  readiness?: any;
  share?: any;
  hasEmailProof?: boolean;
};

export function readinessBannerTitle(targetType: "invoice" | "quote" | string) {
  return targetType === "quote" ? "Contrôle avant envoi" : "Contrôle avant émission";
}

function normalizeDangerLevel(value: any): ReadinessDangerLevel {
  const level = String(value || "").trim();
  if (["none", "info", "warning", "danger", "success"].includes(level)) return level as ReadinessDangerLevel;
  return "info";
}

export function normalizeReadinessNextAction(value: any): ReadinessNextAction | null {
  if (!value || typeof value !== "object") return null;
  const kind = String(value.kind || "").trim();
  const label = String(value.label || "").trim();
  if (!kind || !label) return null;
  return {
    kind,
    label,
    reason: String(value.reason || value.description || "").trim(),
    danger_level: normalizeDangerLevel(value.danger_level || value.dangerLevel),
    autoFixable: Boolean(value.autoFixable ?? value.auto_fixable),
    apiAction: value.apiAction || value.api_action || null,
  };
}

function readinessChecks(readiness: any) {
  return Array.isArray(readiness?.checks) ? readiness.checks : [];
}

export function readinessHasCheck(readiness: any, ...codes: string[]) {
  const expected = new Set(codes);
  return readinessChecks(readiness).some((check: any) => expected.has(String(check?.code || "")));
}

export function readinessIsAutoFixable(readiness: any) {
  return Boolean(readiness?.autoFixable) || readinessChecks(readiness).some((check: any) => check?.auto_fixable);
}

function hasBillableLines(document: any) {
  return (
    Array.isArray(document?.lines) && document.lines.some((line: any) => String(line?.line_type || "item") === "item")
  );
}

function action(
  kind: string,
  label: string,
  reason: string,
  danger_level: ReadinessDangerLevel = "info",
  options: Partial<Pick<ReadinessNextAction, "autoFixable" | "apiAction">> = {},
): ReadinessNextAction {
  return {
    kind,
    label,
    reason,
    danger_level,
    autoFixable: Boolean(options.autoFixable),
    apiAction: options.apiAction || null,
  };
}

export function resolveInvoiceReadinessNextAction({
  invoice,
  readiness,
  canFollowup = false,
}: ResolveInvoiceReadinessInput): ReadinessNextAction {
  const fromApi = normalizeReadinessNextAction(readiness?.next_action);
  if (fromApi && fromApi.kind !== "auto_fix") return fromApi;
  if (!invoice) return action("load_document", "Charger la facture", "La facture doit être disponible.", "none");
  if (!invoice.customer_id || readinessHasCheck(readiness, "customer_missing")) {
    return action("choose_customer", "Choisir un client", "Un client est requis avant émission.", "danger");
  }
  if (!hasBillableLines(invoice) || readinessHasCheck(readiness, "invoice_lines_missing")) {
    return action("add_line", "Ajouter une ligne", "Au moins une ligne produit ou service est nécessaire.", "danger");
  }
  const status = String(invoice.status || "").toLowerCase();
  const balanceDue = Math.max(0, Number(invoice.balance_due || 0));
  if (status === "paid" || balanceDue <= 0) {
    return action("none_paid", "Facture soldée", "Aucune relance ni alerte n'est nécessaire.", "none");
  }
  if (status === "draft") {
    return action("issue_invoice", "Émettre définitivement", "La facture peut être rendue définitive.", "info");
  }
  if (status === "overdue" && canFollowup) {
    return action("followup", "Préparer une relance", "La facture est en retard avec un solde restant dû.", "danger");
  }
  if (!invoice.sent_at)
    return action("send_invoice", "Envoyer", "La facture est émise mais pas encore envoyée.", "info");
  return action("record_payment", "Enregistrer un règlement", "Un solde reste à encaisser.", "success");
}

export function resolveQuoteReadinessNextAction({
  quote,
  readiness,
  share,
}: ResolveQuoteReadinessInput): ReadinessNextAction {
  const fromApi = normalizeReadinessNextAction(readiness?.next_action);
  if (fromApi && fromApi.kind !== "auto_fix") return fromApi;
  if (!quote) return action("load_document", "Charger le devis", "Le devis doit être disponible.", "none");
  if (!quote.customer_id || readinessHasCheck(readiness, "customer_missing")) {
    return action("choose_customer", "Choisir un client", "Un client est requis avant l'envoi.", "danger");
  }
  if (!hasBillableLines(quote) || readinessHasCheck(readiness, "quote_lines_missing")) {
    return action("add_line", "Ajouter une ligne", "Au moins une ligne produit ou service est nécessaire.", "danger");
  }
  const status = String(quote.status || "").toLowerCase();
  if (quote.invoice_id || status === "invoiced") {
    return action("view_invoice", "Voir la facture", "Ce devis est déjà facturé.", "none");
  }
  if (status === "expired" || status === "rejected" || readinessHasCheck(readiness, "quote_expired")) {
    return action("duplicate_quote", "Faire une copie modifiable", "Le devis est figé.", "warning");
  }
  if (status === "accepted") {
    return action("create_invoice", "Créer la facture", "Le client a accepté le devis.", "success");
  }
  if (status === "sent") {
    const viewCount = Number(share?.view_count ?? share?.views ?? quote?.public_view_count ?? 0);
    if (viewCount <= 0) {
      return action("copy_link", "Copier le lien", "Le devis envoyé n'a pas encore été consulté.", "info");
    }
    return action("followup", "Préparer une relance", "Le devis a été consulté sans réponse.", "warning");
  }
  return action("send_quote", "Envoyer le devis", "Le devis est prêt à être envoyé au client.", "info");
}
