"""Add pdp accounts table

Revision ID: 20260601_00
Revises: 20260528_01
Create Date: 2026-06-01
"""

from alembic import op
import sqlalchemy as sa

revision = "20260601_00"
down_revision = "20260528_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    try:
        op.create_table(
            "pdp_accounts",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("provider", sa.String(), nullable=False),
            sa.Column("provider_client_id", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=True),
            sa.Column("raw_json", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint("tenant_id", "provider", name="uniq_pdp_account_per_tenant"),
        )
    except Exception:
        pass
    try:
        op.create_index("ix_pdp_accounts_tenant_id", "pdp_accounts", ["tenant_id"])
    except Exception:
        pass
    try:
        op.create_index("ix_pdp_accounts_provider_client_id", "pdp_accounts", ["provider_client_id"])
    except Exception:
        pass


def downgrade() -> None:
    try:
        op.drop_index("ix_pdp_accounts_provider_client_id", table_name="pdp_accounts")
    except Exception:
        pass
    try:
        op.drop_index("ix_pdp_accounts_tenant_id", table_name="pdp_accounts")
    except Exception:
        pass
    try:
        op.drop_table("pdp_accounts")
    except Exception:
        pass
