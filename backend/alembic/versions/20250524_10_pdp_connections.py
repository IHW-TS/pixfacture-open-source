"""Add PDP connections and invoice transmissions

Revision ID: 20250524_10
Revises: 20250520_09
Create Date: 2025-05-24
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20250524_10"
down_revision = "20250520_09"
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
            "pdp_connections",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("provider_slug", sa.String(), nullable=False),
            sa.Column("auth_type", sa.String(), nullable=False),
            sa.Column("encrypted_credentials", sa.LargeBinary(), nullable=True),
            sa.Column("status", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint("tenant_id", "provider_slug", name="uniq_pdp_connection_per_tenant"),
        )
    except Exception:
        pass

    _safe_create_index("ix_pdp_connections_tenant_id", "pdp_connections", ["tenant_id"])
    _safe_create_index(
        "ix_pdp_connections_tenant_provider",
        "pdp_connections",
        ["tenant_id", "provider_slug"],
    )

    try:
        op.create_table(
            "invoice_transmissions",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("invoice_id", sa.String(), sa.ForeignKey("invoices.id"), nullable=False),
            sa.Column("provider_slug", sa.String(), nullable=False),
            sa.Column("external_id", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )
    except Exception:
        pass

    _safe_create_index("ix_invoice_transmissions_invoice_id", "invoice_transmissions", ["invoice_id"])
    _safe_create_index("ix_invoice_transmissions_external_id", "invoice_transmissions", ["external_id"])


def downgrade() -> None:
    try:
        op.drop_index("ix_invoice_transmissions_external_id", table_name="invoice_transmissions")
    except Exception:
        pass
    try:
        op.drop_index("ix_invoice_transmissions_invoice_id", table_name="invoice_transmissions")
    except Exception:
        pass
    try:
        op.drop_table("invoice_transmissions")
    except Exception:
        pass

    try:
        op.drop_index("ix_pdp_connections_tenant_provider", table_name="pdp_connections")
    except Exception:
        pass
    try:
        op.drop_index("ix_pdp_connections_tenant_id", table_name="pdp_connections")
    except Exception:
        pass
    try:
        op.drop_table("pdp_connections")
    except Exception:
        pass
