"""Add tenant logo storage key

Revision ID: 20260406_01
Revises: 20260406_00
Create Date: 2026-04-06
"""

from alembic import op
import sqlalchemy as sa


revision = "20260406_01"
down_revision = "20260406_00"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "tenants", "logo_storage_key"):
        op.add_column("tenants", sa.Column("logo_storage_key", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "tenants", "logo_storage_key"):
        op.drop_column("tenants", "logo_storage_key")
