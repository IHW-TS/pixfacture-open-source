"""Add e-invoicing endpoints and transmissions

Revision ID: 20260115_12
Revises: 20260115_11
Create Date: 2026-01-15
"""

from alembic import op
import sqlalchemy as sa

revision = "20260115_12"
down_revision = "20260115_11"
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
            "einvoicing_endpoints",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("siren", sa.String(), nullable=False),
            sa.Column("siret", sa.String(), nullable=True),
            sa.Column("platform", sa.String(), nullable=False),
            sa.Column("address", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
    except Exception:
        pass

    _safe_create_index("ix_einvoicing_endpoints_tenant_id", "einvoicing_endpoints", ["tenant_id"])
    _safe_create_index("ix_einvoicing_endpoints_siren", "einvoicing_endpoints", ["siren"])
    _safe_create_index("ix_einvoicing_endpoints_siret", "einvoicing_endpoints", ["siret"])

    try:
        op.create_table(
            "einvoicing_transmissions",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=False),
            sa.Column("channel", sa.String(), nullable=False),
            sa.Column("external_id", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("payload_hash", sa.String(), nullable=True),
            sa.Column("events", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
    except Exception:
        pass

    _safe_create_index("ix_einvoicing_transmissions_invoice_id", "einvoicing_transmissions", ["invoice_id"])
    _safe_create_index("ix_einvoicing_transmissions_external_id", "einvoicing_transmissions", ["external_id"])


def downgrade() -> None:
    try:
        op.drop_index("ix_einvoicing_transmissions_external_id", table_name="einvoicing_transmissions")
    except Exception:
        pass
    try:
        op.drop_index("ix_einvoicing_transmissions_invoice_id", table_name="einvoicing_transmissions")
    except Exception:
        pass
    try:
        op.drop_table("einvoicing_transmissions")
    except Exception:
        pass

    try:
        op.drop_index("ix_einvoicing_endpoints_siret", table_name="einvoicing_endpoints")
    except Exception:
        pass
    try:
        op.drop_index("ix_einvoicing_endpoints_siren", table_name="einvoicing_endpoints")
    except Exception:
        pass
    try:
        op.drop_index("ix_einvoicing_endpoints_tenant_id", table_name="einvoicing_endpoints")
    except Exception:
        pass
    try:
        op.drop_table("einvoicing_endpoints")
    except Exception:
        pass
