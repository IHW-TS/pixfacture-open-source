"use client";

import PaperSheet from "@/components/paper/PaperSheet";
import PaperLinesTable, { type PaperLine } from "@/components/paper/PaperLinesTable";

const safe = (v: any) => (v === null || v === undefined ? "" : String(v));

type TemplateOptions = {
  show_delivery_address?: boolean;
  show_purchase_order_number?: boolean;
  show_note?: boolean;
};

type Props = {
  companyProfile?: any | null;
  selectedCustomer?: any | null;

  customerQuery: string;
  customers: any[];
  customerLoading: boolean;
  customerSearchError: string | null;
  onCustomerQueryChange: (value: string) => void;
  onSelectCustomer: (customer: any) => void;
  onClearSelectedCustomer: () => void;
  onOpenCustomerModal: () => void;

  currency: string;
  onCurrencyChange: (value: string) => void;

  paymentTerms: string;
  onPaymentTermsChange: (value: string) => void;

  serviceDate: string;
  onServiceDateChange: (value: string) => void;

  purchaseOrderNumber: string;
  onPurchaseOrderNumberChange: (value: string) => void;
  enablePurchaseOrder: boolean;

  enableDeliveryAddress: boolean;
  deliveryDifferent: boolean;
  onDeliveryDifferentChange: (value: boolean) => void;
  deliveryAddress: string;
  onDeliveryAddressChange: (value: string) => void;

  operationNature: string;
  onOperationNatureChange: (value: string) => void;

  note: string;
  onNoteChange: (value: string) => void;

  dueDateLabel: string;
  issueDateLabel: string;

  lines: PaperLine[];
  lineWarnings?: string[][];
  onChangeLine: (index: number, field: keyof PaperLine, value: any) => void;
  onAddLine: () => void;
  onRemoveLine: (index: number) => void;

  // Paper templates (aligné avec les templates PDF)
  templateKey?: string; // classic | graphite | ivory
  templateOptions?: TemplateOptions;

  // Catalogue (autocomplete désignation)
  catalogItems?: any[];
  catalogLoading?: boolean;
  catalogQuery?: string;
  onCatalogQueryChange?: (value: string) => void;
  onSelectCatalogItem?: (index: number, item: any) => void;

  disabled?: boolean;
};

const truncate = (text: string, max = 160) => {
  const t = (text || "").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, max).trim() + "…";
};

export default function PaperInvoiceEditor({
  companyProfile,
  selectedCustomer,
  customerQuery,
  customers,
  customerLoading,
  customerSearchError,
  onCustomerQueryChange,
  onSelectCustomer,
  onClearSelectedCustomer,
  onOpenCustomerModal,
  currency,
  onCurrencyChange,
  paymentTerms,
  onPaymentTermsChange,
  serviceDate,
  onServiceDateChange,
  purchaseOrderNumber,
  onPurchaseOrderNumberChange,
  enablePurchaseOrder,
  enableDeliveryAddress,
  deliveryDifferent,
  onDeliveryDifferentChange,
  deliveryAddress,
  onDeliveryAddressChange,
  operationNature,
  onOperationNatureChange,
  note,
  onNoteChange,
  dueDateLabel,
  issueDateLabel,
  lines,
  lineWarnings,
  onChangeLine,
  onAddLine,
  onRemoveLine,
  templateKey = "classic",
  templateOptions,
  catalogItems,
  catalogLoading,
  catalogQuery,
  onCatalogQueryChange,
  onSelectCatalogItem,
  disabled,
}: Props) {
  const supplierName = safe(companyProfile?.name || companyProfile?.company_name || "");
  const supplierAddress = safe(companyProfile?.address || "");
  const supplierSiret = safe(companyProfile?.siret || "");
  const supplierVat = safe(companyProfile?.vat_number || "");
  const supplierLogo = safe(companyProfile?.logo_url || "");

  const iban = safe(companyProfile?.iban || "");
  const bic = safe(companyProfile?.bic || "");
  const legalMentions = safe(companyProfile?.legal_mentions || "");
  const latePayment = safe(companyProfile?.late_payment_interest || "");
  const vatExempt = safe(companyProfile?.vat_exemption_notice || "");

  const customerName = safe(selectedCustomer?.name || "");
  const customerAddress = safe(selectedCustomer?.address || "");
  const customerSiret = safe(selectedCustomer?.siret || selectedCustomer?.siren || "");
  const customerVat = safe(selectedCustomer?.vat_number || "");

  const showDropdown = customerQuery.trim().length >= 2 && Array.isArray(customers) && customers.length > 0;

  const showPO = Boolean(enablePurchaseOrder && (templateOptions?.show_purchase_order_number ?? true));
  const showDelivery = Boolean(enableDeliveryAddress && (templateOptions?.show_delivery_address ?? true));
  const showNote = Boolean(templateOptions?.show_note ?? true);

  return (
    <PaperSheet className="paper-sheet--invoice" templateKey={templateKey}>
      <div className="paper-header">
        <div className="paper-supplier">
          <div className="paper-block__title">Émetteur</div>

          <div className="paper-supplier__row">
            {supplierLogo ? (
              <div className="paper-supplier__logo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={supplierLogo} alt="Logo" className="paper-supplier__logo-img" />
              </div>
            ) : null}

            <div className="paper-text">
              <div className="paper-strong">{supplierName || "(Entreprise à configurer)"}</div>
              <div className="paper-muted">{supplierAddress || "Renseignez l’adresse dans Entreprise"}</div>
              <div className="paper-muted">
                {supplierSiret ? `SIRET: ${supplierSiret}` : "SIRET requis (Entreprise)"}
                {supplierVat ? ` • TVA: ${supplierVat}` : ""}
              </div>
              <div className="paper-muted">
                <a href="/app/company" className="link-dotted">
                  Modifier l’entreprise
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className="paper-meta">
          <div className="paper-doc-title">FACTURE</div>
          <div className="paper-meta-grid">
            <div className="paper-meta-row">
              <span className="paper-meta-label">Date d’émission</span>
              <span className="paper-meta-value">{issueDateLabel}</span>
            </div>
            <div className="paper-meta-row">
              <span className="paper-meta-label">Date de prestation</span>
              <input
                className="paper-input paper-input--inline"
                type="date"
                value={serviceDate}
                onChange={(e) => onServiceDateChange(e.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="paper-meta-row">
              <span className="paper-meta-label">Échéance</span>
              <span className="paper-meta-value">{dueDateLabel}</span>
            </div>
            <div className="paper-meta-row">
              <span className="paper-meta-label">Devise</span>
              <select
                className="paper-input paper-input--inline"
                value={currency}
                onChange={(e) => onCurrencyChange(e.target.value)}
                disabled={disabled}
              >
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="paper-two">
        <div className="paper-block">
          <div className="paper-block__header">
            <div className="paper-block__title">Client</div>
            <div className="paper-block__actions">
              <button type="button" className="btn ghost btn-sm" onClick={onOpenCustomerModal} disabled={disabled}>
                + Nouveau
              </button>
            </div>
          </div>

          {!selectedCustomer ? (
            <div className="paper-client-search">
              <div className="input-with-action">
                <input
                  className="paper-input"
                  value={customerQuery}
                  placeholder="Rechercher un client (nom, email, SIRET...)"
                  onChange={(e) => onCustomerQueryChange(e.target.value)}
                  disabled={disabled}
                />
                {customerQuery ? (
                  <button
                    className="btn ghost btn-sm input-action"
                    type="button"
                    onClick={() => onCustomerQueryChange("")}
                    disabled={disabled}
                  >
                    Effacer
                  </button>
                ) : null}
              </div>

              {customerQuery.trim().length < 2 ? (
                <div className="paper-muted small">Tapez au moins 2 caractères.</div>
              ) : null}
              {customerLoading ? <div className="paper-muted small">Recherche…</div> : null}
              {customerSearchError ? <div className="paper-error small">{customerSearchError}</div> : null}

              {showDropdown ? (
                <div className="dropdown">
                  {customers.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="dropdown__item"
                      onClick={() => onSelectCustomer(c)}
                      disabled={disabled}
                    >
                      <div className="dropdown__title">{c.name}</div>
                      <div className="dropdown__desc">
                        {[c.email, c.siret || c.siren, c.vat_number].filter(Boolean).join(" • ")}
                      </div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="paper-text">
              <div className="paper-strong">{customerName}</div>
              <div className="paper-muted">{customerAddress || "Adresse client manquante"}</div>
              <div className="paper-muted">
                {customerSiret ? `SIRET/SIREN: ${customerSiret}` : "SIRET/SIREN requis en France (entreprises)"}
                {customerVat ? ` • TVA: ${customerVat}` : ""}
              </div>
              <div className="paper-muted small">
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  onClick={onClearSelectedCustomer}
                  disabled={disabled}
                >
                  Changer
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="paper-block">
          <div className="paper-block__title">Informations</div>
          <div className="paper-form-grid">
            <label className="paper-label">
              <span className="paper-label__text">Conditions de paiement</span>
              <input
                className="paper-input"
                value={paymentTerms}
                onChange={(e) => onPaymentTermsChange(e.target.value)}
                placeholder="Ex: 30 jours fin de mois"
                disabled={disabled}
              />
            </label>

            <label className="paper-label">
              <span className="paper-label__text">Nature de l’opération</span>
              <select
                className="paper-input"
                value={operationNature}
                onChange={(e) => onOperationNatureChange(e.target.value)}
                disabled={disabled}
              >
                <option value="">— choisir —</option>
                <option value="goods">Biens</option>
                <option value="services">Services</option>
                <option value="mixed">Mixte</option>
              </select>
            </label>

            {showPO ? (
              <label className="paper-label">
                <span className="paper-label__text">Bon de commande (PO)</span>
                <input
                  className="paper-input"
                  value={purchaseOrderNumber}
                  onChange={(e) => onPurchaseOrderNumberChange(e.target.value)}
                  placeholder="Ex: PO-2026-001"
                  disabled={disabled}
                />
              </label>
            ) : null}

            {showDelivery ? (
              <div className="paper-label">
                <div className="row gap-8 items-center">
                  <input
                    type="checkbox"
                    checked={deliveryDifferent}
                    onChange={(e) => onDeliveryDifferentChange(e.target.checked)}
                    disabled={disabled}
                    id="deliveryDifferent"
                  />
                  <label htmlFor="deliveryDifferent" className="paper-label__text paper-label__clickable">
                    Adresse de livraison différente
                  </label>
                </div>
                {deliveryDifferent ? (
                  <textarea
                    className="paper-input paper-textarea"
                    value={deliveryAddress}
                    onChange={(e) => onDeliveryAddressChange(e.target.value)}
                    placeholder="Adresse de livraison"
                    disabled={disabled}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="paper-section">
        <div className="paper-section__title">Lignes</div>
        <PaperLinesTable
          lines={lines}
          currencySymbol={currency === "EUR" ? "€" : currency}
          showVatCategory={false}
          onChangeLine={onChangeLine}
          onAddLine={onAddLine}
          onRemoveLine={onRemoveLine}
          lineWarnings={lineWarnings}
          disabled={disabled}
          catalogItems={catalogItems}
          catalogLoading={catalogLoading}
          catalogQuery={catalogQuery}
          onCatalogQueryChange={onCatalogQueryChange}
          onSelectCatalogItem={onSelectCatalogItem}
        />
      </div>

      <div className="paper-footer">
        <div className="paper-footer__grid">
          {showNote ? (
            <div className="paper-note">
              <div className="paper-block__title">Note</div>
              <textarea
                className="paper-input paper-textarea"
                value={note}
                onChange={(e) => onNoteChange(e.target.value)}
                placeholder="Message au client (optionnel)"
                disabled={disabled}
              />
            </div>
          ) : null}

          <div className="paper-note">
            <div className="paper-block__title">Paiement & mentions (auto depuis Entreprise)</div>
            <div className="paper-muted small">
              {iban || bic ? (
                <div className="grid-simple gap-4">
                  {iban ? (
                    <div>
                      <b>IBAN</b> : <span className="mono">{iban}</span>
                    </div>
                  ) : null}
                  {bic ? (
                    <div>
                      <b>BIC</b> : <span className="mono">{bic}</span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div>
                  IBAN/BIC non configurés.{" "}
                  <a href="/app/company" className="link-dotted">
                    Ajouter dans Entreprise
                  </a>
                  .
                </div>
              )}

              <div className="mt-6">
                <b>Mentions</b> : {truncate(legalMentions || vatExempt || latePayment) || "Non renseignées."}{" "}
                <a href="/app/company" className="link-dotted">
                  Modifier
                </a>
              </div>

              <div className="mt-6">
                <span className="muted">
                  Astuce : pour la conformité FR 2026‑2027, vérifiez SIRET/TVA, nature de l’opération et adresse de
                  livraison.
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </PaperSheet>
  );
}
