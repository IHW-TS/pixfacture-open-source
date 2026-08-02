"""Add integration secrets table

Revision ID: 20260701_03
Revises: 20260701_02
Create Date: 2026-01-28
"""

from alembic import op
import sqlalchemy as sa


revision = "20260701_03"
down_revision = "20260701_02"
branch_labels = None
depends_on = None


def _table_exists(conn, table: str) -> bool:
    inspector = sa.inspect(conn)
    return table in inspector.get_table_names()


def upgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "integration_secrets"):
        return
    op.create_table(
        "integration_secrets",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("secret_key", sa.String(), nullable=False),
        sa.Column("encrypted_value", sa.LargeBinary(), nullable=False),
        sa.Column("kid", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("tenant_id", "secret_key", name="uniq_integration_secret"),
    )
    op.create_index("ix_integration_secrets_tenant_id", "integration_secrets", ["tenant_id"])
    op.create_index("ix_integration_secrets_secret_key", "integration_secrets", ["secret_key"])
    op.create_index("ix_integration_secrets_tenant_key", "integration_secrets", ["tenant_id", "secret_key"])


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "integration_secrets"):
        return
    op.drop_index("ix_integration_secrets_tenant_key", table_name="integration_secrets")
    op.drop_index("ix_integration_secrets_secret_key", table_name="integration_secrets")
    op.drop_index("ix_integration_secrets_tenant_id", table_name="integration_secrets")
    op.drop_table("integration_secrets")
