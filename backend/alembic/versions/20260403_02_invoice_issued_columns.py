"""Add issued metadata columns to invoices

Revision ID: 20260403_02
Revises: 20260402_01
Create Date: 2026-04-03
"""

from alembic import op
import sqlalchemy as sa


revision = "20260403_02"
down_revision = "20260402_01"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "invoices", "issued_at"):
        op.add_column("invoices", sa.Column("issued_at", sa.DateTime(), nullable=True))
    if not _column_exists(conn, "invoices", "issued_hash"):
        op.add_column("invoices", sa.Column("issued_hash", sa.String(), nullable=True))
    if not _column_exists(conn, "invoices", "issued_profile"):
        op.add_column("invoices", sa.Column("issued_profile", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "invoices", "issued_profile"):
        op.drop_column("invoices", "issued_profile")
    if _column_exists(conn, "invoices", "issued_hash"):
        op.drop_column("invoices", "issued_hash")
    if _column_exists(conn, "invoices", "issued_at"):
        op.drop_column("invoices", "issued_at")
