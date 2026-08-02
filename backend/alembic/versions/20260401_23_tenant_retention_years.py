"""Add retention_years to tenants

Revision ID: 20260401_23
Revises: 20260401_22
Create Date: 2026-04-01
"""

from alembic import op
import sqlalchemy as sa

revision = "20260401_23"
down_revision = "20260401_22"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("tenants")}
    if "retention_years" not in existing_columns:
        op.add_column(
            "tenants",
            sa.Column("retention_years", sa.Integer(), nullable=False, server_default="10"),
        )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("tenants")}
    if "retention_years" in existing_columns:
        op.drop_column("tenants", "retention_years")
