"""Add inbound invoice inbox tables

Revision ID: 20260410_02
Revises: 20260410_01
Create Date: 2026-04-10
"""

from alembic import op
import sqlalchemy as sa

revision = "20260410_02"
down_revision = "20260410_01"
branch_labels = None
depends_on = None


def _safe_create_index(name: str, table: str, columns: list[str]) -> None:
    try:
        op.create_index(name, table, columns)
    except Exception:
        pass


def upgrade() -> None:
    try:
        op.create_table(
            "inbound_invoices",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("provider_slug", sa.String(), nullable=True),
            sa.Column("supplier_name", sa.String(), nullable=True),
            sa.Column("supplier_siren", sa.String(), nullable=True),
            sa.Column("supplier_siret", sa.String(), nullable=True),
            sa.Column("invoice_number", sa.String(), nullable=True),
            sa.Column("issue_date", sa.Date(), nullable=True),
            sa.Column("total_ttc", sa.Numeric(12, 2), nullable=True),
            sa.Column("currency", sa.String(), nullable=True),
            sa.Column("received_at", sa.DateTime(), nullable=True),
            sa.Column("format", sa.String(), nullable=True),
            sa.Column("external_message_id", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint("tenant_id", "external_message_id", name="uniq_inbound_message_per_tenant"),
        )
    except Exception:
        pass

    _safe_create_index("ix_inbound_invoices_tenant_id", "inbound_invoices", ["tenant_id"])
    _safe_create_index("ix_inbound_invoices_supplier_siren", "inbound_invoices", ["supplier_siren"])
    _safe_create_index("ix_inbound_invoices_supplier_siret", "inbound_invoices", ["supplier_siret"])
    _safe_create_index("ix_inbound_invoices_invoice_number", "inbound_invoices", ["invoice_number"])
    _safe_create_index("ix_inbound_invoices_external_message_id", "inbound_invoices", ["external_message_id"])

    try:
        op.create_table(
            "inbound_invoice_attachments",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("inbound_invoice_id", sa.String(), sa.ForeignKey("inbound_invoices.id"), nullable=False),
            sa.Column("kind", sa.String(), nullable=False),
            sa.Column("storage_key", sa.String(), nullable=False),
            sa.Column("sha256", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )
    except Exception:
        pass

    _safe_create_index(
        "ix_inbound_invoice_attachments_invoice_id",
        "inbound_invoice_attachments",
        ["inbound_invoice_id"],
    )

    try:
        op.create_table(
            "inbound_invoice_events",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("inbound_invoice_id", sa.String(), sa.ForeignKey("inbound_invoices.id"), nullable=False),
            sa.Column("type", sa.String(), nullable=False),
            sa.Column("payload_hash", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )
    except Exception:
        pass

    _safe_create_index(
        "ix_inbound_invoice_events_invoice_id",
        "inbound_invoice_events",
        ["inbound_invoice_id"],
    )


def downgrade() -> None:
    try:
        op.drop_index("ix_inbound_invoice_events_invoice_id", table_name="inbound_invoice_events")
    except Exception:
        pass
    try:
        op.drop_table("inbound_invoice_events")
    except Exception:
        pass

    try:
        op.drop_index("ix_inbound_invoice_attachments_invoice_id", table_name="inbound_invoice_attachments")
    except Exception:
        pass
    try:
        op.drop_table("inbound_invoice_attachments")
    except Exception:
        pass

    try:
        op.drop_index("ix_inbound_invoices_external_message_id", table_name="inbound_invoices")
    except Exception:
        pass
    try:
        op.drop_index("ix_inbound_invoices_invoice_number", table_name="inbound_invoices")
    except Exception:
        pass
    try:
        op.drop_index("ix_inbound_invoices_supplier_siret", table_name="inbound_invoices")
    except Exception:
        pass
    try:
        op.drop_index("ix_inbound_invoices_supplier_siren", table_name="inbound_invoices")
    except Exception:
        pass
    try:
        op.drop_index("ix_inbound_invoices_tenant_id", table_name="inbound_invoices")
    except Exception:
        pass
    try:
        op.drop_table("inbound_invoices")
    except Exception:
        pass
