"use client";

import PaperSheet from "@/components/paper/PaperSheet";
import PaperLinesTable, { type PaperLine } from "@/components/paper/PaperLinesTable";

const safe = (v: any) => (v === null || v === undefined ? "" : String(v));

type Customer = {
  id: string;
  name: string;
  address?: string | null;
  siret?: string | null;
  siren?: string | null;
  vat_number?: string | null;
};

type TemplateKey = "classic" | "graphite" | "ivory" | string;

type Props = {
  companyProfile?: any | null;

  customers: Customer[];
  customerId: string;
  onCustomerIdChange: (id: string) => void;

  validUntil: string;
  onValidUntilChange: (v: string) => void;

  serviceDate: string;
  onServiceDateChange: (v: string) => void;

  purchaseOrderNumber: string;
  onPurchaseOrderNumberChange: (v: string) => void;

  paymentTerms: string;
  onPaymentTermsChange: (v: string) => void;

  note: string;
  onNoteChange: (v: string) => void;

  lines: PaperLine[];
  lineWarnings?: string[][];
  onChangeLine: (index: number, field: keyof PaperLine, value: any) => void;
  onAddLine: () => void;
  onRemoveLine: (index: number) => void;

  templateKey?: TemplateKey;
  onTemplateKeyChange?: (v: TemplateKey) => void;

  // Catalogue (autocomplete désignation)
  catalogItems?: any[];
  catalogLoading?: boolean;
  catalogQuery?: string;
  onCatalogQueryChange?: (value: string) => void;
  onSelectCatalogItem?: (index: number, item: any) => void;

  disabled?: boolean;
};

export default function PaperQuoteEditor({
  companyProfile,
  customers,
  customerId,
  onCustomerIdChange,
  validUntil,
  onValidUntilChange,
  serviceDate,
  onServiceDateChange,
  purchaseOrderNumber,
  onPurchaseOrderNumberChange,
  paymentTerms,
  onPaymentTermsChange,
  note,
  onNoteChange,
  lines,
  lineWarnings,
  onChangeLine,
  onAddLine,
  onRemoveLine,
  templateKey = "classic",
  onTemplateKeyChange,
  catalogItems,
  catalogLoading,
  catalogQuery,
  onCatalogQueryChange,
  onSelectCatalogItem,
  disabled,
}: Props) {
  const customer = customers.find((c) => c.id === customerId);

  const supplierName = safe(companyProfile?.name || companyProfile?.company_name || "Entreprise");
  const supplierAddress = safe(companyProfile?.address || "");
  const supplierSiret = safe(companyProfile?.siret || "");
  const supplierVat = safe(companyProfile?.vat_number || "");
  const supplierLogo = safe(companyProfile?.logo_url || "");

  return (
    <PaperSheet className="paper-sheet--quote" templateKey={templateKey}>
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
              <div className="paper-strong">{supplierName}</div>
              {supplierAddress ? <div className="paper-muted">{supplierAddress}</div> : null}
              <div className="paper-muted">
                {supplierSiret ? `SIRET: ${supplierSiret}` : "SIRET manquant"}
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
          <div className="paper-doc-title">DEVIS</div>
          <div className="paper-meta-grid">
            <div className="paper-meta-row">
              <span className="paper-meta-label">Valable jusqu’au</span>
              <input
                className="paper-input paper-input--inline"
                type="date"
                value={validUntil}
                onChange={(e) => onValidUntilChange(e.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="paper-meta-row">
              <span className="paper-meta-label">Date de service</span>
              <input
                className="paper-input paper-input--inline"
                type="date"
                value={serviceDate}
                onChange={(e) => onServiceDateChange(e.target.value)}
                disabled={disabled}
              />
            </div>
            {onTemplateKeyChange ? (
              <div className="paper-meta-row">
                <span className="paper-meta-label">Style</span>
                <select
                  className="paper-input paper-input--inline"
                  value={templateKey as any}
                  onChange={(e) => onTemplateKeyChange(e.target.value)}
                  disabled={disabled}
                >
                  <option value="classic">Classique</option>
                  <option value="graphite">Graphite</option>
                  <option value="ivory">Ivoire</option>
                </select>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="paper-two">
        <div className="paper-block">
          <div className="paper-block__title">Client</div>
          <div className="paper-form-grid">
            <label className="paper-label">
              <span className="paper-label__text">Client</span>
              <select
                className="paper-input"
                value={customerId}
                onChange={(e) => onCustomerIdChange(e.target.value)}
                disabled={disabled}
              >
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {customer ? (
              <div className="paper-muted small">
                {customer.address ? <div>{customer.address}</div> : null}
                <div>
                  {customer.siret || customer.siren ? `SIRET/SIREN: ${customer.siret || customer.siren}` : ""}
                  {customer.vat_number ? ` • TVA: ${customer.vat_number}` : ""}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="paper-block">
          <div className="paper-block__title">Informations</div>
          <div className="paper-form-grid">
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
          </div>
        </div>
      </div>

      <div className="paper-section">
        <div className="paper-section__title">Lignes</div>
        <PaperLinesTable
          lines={lines}
          currencySymbol="€"
          showVatCategory={true}
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
      </div>
    </PaperSheet>
  );
}
