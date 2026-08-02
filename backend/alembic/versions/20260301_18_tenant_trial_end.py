"""Add trial_end to tenants

Revision ID: 20260301_18
Revises: 20260201_17
Create Date: 2026-03-01
"""

from alembic import op
import sqlalchemy as sa


revision = "20260301_18"
down_revision = "20260201_17"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "tenants", "trial_end"):
        op.add_column("tenants", sa.Column("trial_end", sa.DateTime(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "tenants", "trial_end"):
        op.drop_column("tenants", "trial_end")
