"""Add pdp mandates table

Revision ID: 20260520_00
Revises: 20260513_00
Create Date: 2026-05-20
"""

from alembic import op
import sqlalchemy as sa

revision = "20260520_00"
down_revision = "20260513_00"
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
            "pdp_mandates",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("provider_slug", sa.String(), nullable=False, server_default="seqino"),
            sa.Column("mandate_id", sa.String(), nullable=False),
            sa.Column("siren", sa.String(), nullable=True),
            sa.Column("siret", sa.String(), nullable=True),
            sa.Column("suffix", sa.String(), nullable=True),
            sa.Column("routing_identifier", sa.String(), nullable=True),
            sa.Column("name", sa.String(), nullable=True),
            sa.Column("start_date", sa.Date(), nullable=True),
            sa.Column("status", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint("tenant_id", "mandate_id", name="uniq_pdp_mandate_per_tenant"),
        )
    except Exception:
        pass

    _safe_create_index("ix_pdp_mandates_tenant_id", "pdp_mandates", ["tenant_id"])
    _safe_create_index("ix_pdp_mandates_mandate_id", "pdp_mandates", ["mandate_id"])
    _safe_create_index("ix_pdp_mandates_tenant_provider", "pdp_mandates", ["tenant_id", "provider_slug"])


def downgrade() -> None:
    try:
        op.drop_index("ix_pdp_mandates_tenant_provider", table_name="pdp_mandates")
    except Exception:
        pass
    try:
        op.drop_index("ix_pdp_mandates_mandate_id", table_name="pdp_mandates")
    except Exception:
        pass
    try:
        op.drop_index("ix_pdp_mandates_tenant_id", table_name="pdp_mandates")
    except Exception:
        pass
    try:
        op.drop_table("pdp_mandates")
    except Exception:
        pass
