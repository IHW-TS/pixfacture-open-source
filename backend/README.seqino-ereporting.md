# Seqino e-reporting modes

This document describes how Seqino e-reporting behaves depending on the
`EREPORTING_SEQINO_MODE` environment flag.

## Modes

### payments_only
- Sends only events/lines where `event_type` contains `payment`.
- Non-payment events (including `b2c_sale` and `international_sale`) are skipped
  with an explicit log entry and a `skipped` status.
- Calls `POST /reporting/payments` with payload:
  - `client_siren` (required; from metadata or tenant siren fallback)
  - `payment_date` (required)
  - `amount` (required)
  - `currency` (optional)
  - `payment_id` (optional; uses metadata or the payment source id when available)

### full
- Payments use the same `POST /reporting/payments` payload as above.
- `b2c_sale` is aggregated by `transaction_date` (metadata `event_date`) and sent
  to `POST /reporting/b2c-transactions` with:
  - `transaction_date`, `currency`, optional `store_location`
  - `goods_sales` and/or `services_sales` grouped by VAT rate
  - Aggregation uses metadata `goods_sales`/`services_sales` lists when provided,
    otherwise it derives VAT rate and amount from totals.
- `international_sale` uses an InvoiceDraftModel-Input payload and is sent to
  `POST /reporting/exempt-invoices` with:
  - `model` (invoice draft), plus `direction` and `country_code`
  - Report-generated lines inject `invoice_draft` metadata built from invoice,
    customer, and invoice lines.
  - Custom events must supply `invoice_draft` (or `model`) in metadata.

## Metadata injected by reports
- `event_date` is added to line metadata from invoice issue date or payment date.
- `payment_id` is added to payment lines from the payment source id.
- `invoice_draft` is added for `international_sale` lines using invoice data.

## Mode selection
- `EREPORTING_SEQINO_MODE` overrides credential-level overrides.
- Supported values: `payments_only`, `full`, `seqino_v1` (legacy fallback).
