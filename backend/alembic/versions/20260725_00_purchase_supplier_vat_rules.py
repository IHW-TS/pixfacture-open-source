"""Add purchase supplier VAT rules

Revision ID: 20260725_supplier_vat_rules
Revises: 20260724_export_comments
Create Date: 2026-07-25 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260725_supplier_vat_rules"
down_revision = "20260724_export_comments"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    inspector = sa.inspect(conn)
    return table_name in inspector.get_table_names()


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "purchase_suppliers"):
        return
    if not _column_exists(conn, "purchase_suppliers", "default_vat_rate"):
        op.add_column("purchase_suppliers", sa.Column("default_vat_rate", sa.Numeric(5, 2), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "purchase_suppliers"):
        return
    if _column_exists(conn, "purchase_suppliers", "default_vat_rate"):
        op.drop_column("purchase_suppliers", "default_vat_rate")
