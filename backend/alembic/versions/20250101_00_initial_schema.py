"""Initial schema

Revision ID: 20250101_00
Revises: None
Create Date: 2025-05-20
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20250101_00"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tenants",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("tenant_slug", sa.String(), nullable=False, unique=True),
        sa.Column("plan", sa.String(), nullable=True),
        sa.Column("stripe_customer_id", sa.String(), nullable=True),
        sa.Column("stripe_subscription_id", sa.String(), nullable=True),
        sa.Column("subscription_status", sa.String(), nullable=True),
        sa.Column("trial_end", sa.DateTime(), nullable=True),
        sa.Column("siret", sa.String(), nullable=True),
        sa.Column("rcs", sa.String(), nullable=True),
        sa.Column("legal_form", sa.String(), nullable=True),
        sa.Column("share_capital", sa.String(), nullable=True),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("address_line1", sa.String(), nullable=True),
        sa.Column("address_line2", sa.String(), nullable=True),
        sa.Column("postal_code", sa.String(), nullable=True),
        sa.Column("city", sa.String(), nullable=True),
        sa.Column("country_code", sa.String(), nullable=True),
        sa.Column("country", sa.String(), nullable=False),
        sa.Column("vat_number", sa.String(), nullable=True),
        sa.Column("vat_on_debits", sa.Boolean(), nullable=True),
        sa.Column("vat_regime", sa.String(), nullable=False),
        sa.Column("transaction_periodicity", sa.String(), nullable=True),
        sa.Column("payment_periodicity", sa.String(), nullable=True),
        sa.Column("payments_reporting_enabled", sa.Boolean(), nullable=False),
        sa.Column("ereporting_sync_status", sa.String(), nullable=True),
        sa.Column("seqino_last_periodicity_sync_at", sa.DateTime(), nullable=True),
        sa.Column("seqino_last_periodicity_sync_status", sa.String(), nullable=True),
        sa.Column("iban", sa.String(), nullable=True),
        sa.Column("bic", sa.String(), nullable=True),
        sa.Column("logo_url", sa.String(), nullable=True),
        sa.Column("logo_storage_key", sa.String(), nullable=True),
        sa.Column("legal_mentions", sa.Text(), nullable=True),
        sa.Column("vat_exemption_notice", sa.Text(), nullable=True),
        sa.Column("late_payment_interest", sa.String(), nullable=True),
        sa.Column("recovery_fee_eur", sa.Numeric(10, 2), nullable=True),
        sa.Column("discount_terms", sa.String(), nullable=True),
        sa.Column("email_subject_default", sa.Text(), nullable=True),
        sa.Column("email_body_default", sa.Text(), nullable=True),
        sa.Column("reminder_body_default", sa.Text(), nullable=True),
        sa.Column("email_reply_to", sa.String(), nullable=True),
        sa.Column("retention_years", sa.Integer(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("deleted_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_tenants_tenant_slug", "tenants", ["tenant_slug"])

    op.create_table(
        "users",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("email", sa.String(), nullable=False, unique=True),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=True),
        sa.Column("is_admin", sa.Boolean(), nullable=True),
        sa.Column("is_support", sa.Boolean(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("token_version", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_users_tenant_id", "users", ["tenant_id"])

    op.create_table(
        "memberships",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "tenant_id", name="uniq_membership_user_tenant"),
    )
    op.create_index("ix_memberships_user_id", "memberships", ["user_id"])
    op.create_index("ix_memberships_tenant_id", "memberships", ["tenant_id"])

    op.create_table(
        "customers",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("client_type", sa.String(), nullable=True),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column("phone", sa.String(), nullable=True),
        sa.Column("contact_name", sa.String(), nullable=True),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("address_line1", sa.String(), nullable=True),
        sa.Column("address_line2", sa.String(), nullable=True),
        sa.Column("postal_code", sa.String(), nullable=True),
        sa.Column("city", sa.String(), nullable=True),
        sa.Column("country_code", sa.String(), nullable=True),
        sa.Column("siret", sa.String(), nullable=True),
        sa.Column("siren", sa.String(), nullable=True),
        sa.Column("vat_number", sa.String(), nullable=True),
        sa.Column("endpoint_id", sa.String(), nullable=True),
        sa.Column("pdp_name", sa.String(), nullable=True),
        sa.Column("country", sa.String(), nullable=True),
        sa.Column("payment_terms_default", sa.Text(), nullable=True),
        sa.Column("payment_method_default", sa.String(), nullable=True),
        sa.Column("default_vat_rate", sa.Numeric(5, 2), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("tenant_id", "siret", name="uniq_customer_siret_per_tenant"),
        sa.UniqueConstraint("tenant_id", "vat_number", name="uniq_customer_vat_per_tenant"),
        sa.UniqueConstraint("tenant_id", "email", name="uniq_customer_email_per_tenant"),
    )
    op.create_index("ix_customers_tenant_id", "customers", ["tenant_id"])
    op.create_index("ix_customers_created_at", "customers", ["created_at"])

    op.create_table(
        "user_invites",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False, unique=True),
        sa.Column("invited_by_user_id", sa.String(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("accepted_by_user_id", sa.String(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("customer_id", sa.String(), sa.ForeignKey("customers.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("accepted_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_user_invites_tenant_id", "user_invites", ["tenant_id"])
    op.create_index("ix_user_invites_email", "user_invites", ["email"])
    op.create_index("ix_user_invites_invited_by_user_id", "user_invites", ["invited_by_user_id"])
    op.create_index("ix_user_invites_accepted_by_user_id", "user_invites", ["accepted_by_user_id"])
    op.create_index("ix_user_invites_customer_id", "user_invites", ["customer_id"])

    op.create_table(
        "products",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("unit_price", sa.Numeric(10, 2), nullable=False),
        sa.Column("vat_rate", sa.Numeric(5, 2), nullable=False),
        sa.Column("unit_code", sa.String(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_products_tenant_id", "products", ["tenant_id"])

    op.create_table(
        "invoices",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("customer_id", sa.String(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("number", sa.String(), nullable=True),
        sa.Column("currency", sa.String(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("purchase_order_number", sa.String(), nullable=True),
        sa.Column("payment_terms", sa.Text(), nullable=True),
        sa.Column("due_date", sa.DateTime(), nullable=True),
        sa.Column("due_date_manual", sa.Boolean(), nullable=False),
        sa.Column("type", sa.String(), nullable=True),
        sa.Column("related_invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.String(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("updated_by", sa.String(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("delivery_address", sa.Text(), nullable=True),
        sa.Column("delivery_address_differs", sa.Boolean(), nullable=False),
        sa.Column("operation_nature", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("issue_date", sa.DateTime(), nullable=True),
        sa.Column("service_date", sa.Date(), nullable=True),
        sa.Column("due_days", sa.Integer(), nullable=True),
        sa.Column("total_ex_vat", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_vat", sa.Numeric(12, 2), nullable=True),
        sa.Column("total_inc_vat", sa.Numeric(12, 2), nullable=True),
        sa.Column("allowance_total", sa.Numeric(12, 2), nullable=True),
        sa.Column("charge_total", sa.Numeric(12, 2), nullable=True),
        sa.Column("seller_snapshot", sa.JSON(), nullable=True),
        sa.Column("buyer_snapshot", sa.JSON(), nullable=True),
        sa.Column("pdf_key", sa.String(), nullable=True),
        sa.Column("pdf_size", sa.Integer(), nullable=True),
        sa.Column("xml_key", sa.String(), nullable=True),
        sa.Column("xml_size", sa.Integer(), nullable=True),
        sa.Column("facturx_key", sa.String(), nullable=True),
        sa.Column("facturx_size", sa.Integer(), nullable=True),
        sa.Column("pdf_checksum", sa.String(), nullable=True),
        sa.Column("xml_checksum", sa.String(), nullable=True),
        sa.Column("facturx_checksum", sa.String(), nullable=True),
        sa.Column("pdfa3_status", sa.String(), nullable=True),
        sa.Column("pdfa3_report", sa.Text(), nullable=True),
        sa.Column("facturx_spec_version", sa.String(), nullable=True),
        sa.Column("issued_at", sa.DateTime(), nullable=True),
        sa.Column("issued_hash", sa.String(), nullable=True),
        sa.Column("issued_profile", sa.String(), nullable=True),
        sa.Column("sent_at", sa.DateTime(), nullable=True),
        sa.Column("paid_at", sa.DateTime(), nullable=True),
        sa.Column("reminder_count", sa.Integer(), nullable=True),
        sa.Column("last_reminder_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("tenant_id", "number", name="uq_invoices_tenant_number"),
    )
    op.create_index("ix_invoices_tenant_id", "invoices", ["tenant_id"])
    op.create_index("ix_invoices_customer_id", "invoices", ["customer_id"])
    op.create_index("ix_invoices_number", "invoices", ["number"])
    op.create_index("ix_invoices_due_date", "invoices", ["due_date"])
    op.create_index("ix_invoices_related_invoice_id", "invoices", ["related_invoice_id"])
    op.create_index("ix_invoices_issue_date", "invoices", ["issue_date"])
    op.create_index("ix_invoices_tenant_number", "invoices", ["tenant_id", "number"])

    op.create_table(
        "invoice_lines",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=False),
        sa.Column("product_name", sa.String(), nullable=False),
        sa.Column("quantity", sa.Numeric(10, 2), nullable=False),
        sa.Column("unit_price", sa.Numeric(10, 2), nullable=False),
        sa.Column("vat_rate", sa.Numeric(5, 2), nullable=False),
        sa.Column("vat_category", sa.String(), nullable=True),
        sa.Column("exemption_reason_code", sa.String(), nullable=True),
        sa.Column("unit_code", sa.String(), nullable=True),
        sa.Column("item_id", sa.String(), nullable=True),
        sa.Column("line_total", sa.Numeric(12, 2), nullable=False),
    )
    op.create_index("ix_invoice_lines_invoice_id", "invoice_lines", ["invoice_id"])

    op.create_table(
        "numbering",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("prefix", sa.String(), nullable=True),
        sa.Column("last_index", sa.Integer(), nullable=True),
        sa.Column("year", sa.Integer(), nullable=True),
        sa.UniqueConstraint("tenant_id", name="uniq_numbering_per_tenant"),
    )
    op.create_index("ix_numbering_tenant_id", "numbering", ["tenant_id"])

    op.create_table(
        "payments",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=False),
        sa.Column("date", sa.DateTime(), nullable=False),
        sa.Column("method", sa.String(), nullable=True),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("reference", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.String(), sa.ForeignKey("users.id"), nullable=True),
    )
    op.create_index("ix_payments_invoice_id", "payments", ["invoice_id"])

    op.create_table(
        "action_logs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("entity", sa.String(), nullable=False),
        sa.Column("entity_id", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_action_logs_tenant_id", "action_logs", ["tenant_id"])
    op.create_index("ix_action_logs_user_id", "action_logs", ["user_id"])
    op.create_index("ix_action_logs_entity_id", "action_logs", ["entity_id"])

    op.create_table(
        "submissions",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=False),
        sa.Column("channel", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=True),
        sa.Column("external_id", sa.String(), nullable=True),
        sa.Column("message_id", sa.String(), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("errors", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_submissions_invoice_id", "submissions", ["invoice_id"])
    op.create_index("ix_submissions_external_id", "submissions", ["external_id"])
    op.create_index("ix_submissions_message_id", "submissions", ["message_id"])

    op.create_table(
        "api_keys",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("token_hash", sa.String(), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_api_keys_tenant_id", "api_keys", ["tenant_id"])

    op.create_table(
        "stripe_events",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("event_id", sa.String(), nullable=False, unique=True),
        sa.Column("received_at", sa.DateTime(), nullable=False),
        sa.Column("processed_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_stripe_events_event_id", "stripe_events", ["event_id"])


def downgrade() -> None:
    op.drop_index("ix_stripe_events_event_id", table_name="stripe_events")
    op.drop_table("stripe_events")

    op.drop_index("ix_api_keys_tenant_id", table_name="api_keys")
    op.drop_table("api_keys")

    op.drop_index("ix_submissions_message_id", table_name="submissions")
    op.drop_index("ix_submissions_external_id", table_name="submissions")
    op.drop_index("ix_submissions_invoice_id", table_name="submissions")
    op.drop_table("submissions")

    op.drop_index("ix_action_logs_entity_id", table_name="action_logs")
    op.drop_index("ix_action_logs_user_id", table_name="action_logs")
    op.drop_index("ix_action_logs_tenant_id", table_name="action_logs")
    op.drop_table("action_logs")

    op.drop_index("ix_payments_invoice_id", table_name="payments")
    op.drop_table("payments")

    op.drop_index("ix_numbering_tenant_id", table_name="numbering")
    op.drop_table("numbering")

    op.drop_index("ix_invoice_lines_invoice_id", table_name="invoice_lines")
    op.drop_table("invoice_lines")

    op.drop_index("ix_invoices_tenant_number", table_name="invoices")
    op.drop_index("ix_invoices_issue_date", table_name="invoices")
    op.drop_index("ix_invoices_related_invoice_id", table_name="invoices")
    op.drop_index("ix_invoices_due_date", table_name="invoices")
    op.drop_index("ix_invoices_number", table_name="invoices")
    op.drop_index("ix_invoices_customer_id", table_name="invoices")
    op.drop_index("ix_invoices_tenant_id", table_name="invoices")
    op.drop_table("invoices")

    op.drop_index("ix_user_invites_customer_id", table_name="user_invites")
    op.drop_index("ix_user_invites_accepted_by_user_id", table_name="user_invites")
    op.drop_index("ix_user_invites_invited_by_user_id", table_name="user_invites")
    op.drop_index("ix_user_invites_email", table_name="user_invites")
    op.drop_index("ix_user_invites_tenant_id", table_name="user_invites")
    op.drop_table("user_invites")

    op.drop_index("ix_products_tenant_id", table_name="products")
    op.drop_table("products")

    op.drop_index("ix_customers_created_at", table_name="customers")
    op.drop_index("ix_customers_tenant_id", table_name="customers")
    op.drop_table("customers")

    op.drop_index("ix_memberships_tenant_id", table_name="memberships")
    op.drop_index("ix_memberships_user_id", table_name="memberships")
    op.drop_table("memberships")

    op.drop_index("ix_users_tenant_id", table_name="users")
    op.drop_table("users")

    op.drop_index("ix_tenants_tenant_slug", table_name="tenants")
    op.drop_table("tenants")
