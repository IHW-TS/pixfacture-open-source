"""Add purchase line ventilation

Revision ID: 20260723_purchase_lines
Revises: 20260722_email_delivery_mode
Create Date: 2026-07-23 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260723_purchase_lines"
down_revision = "20260722_email_delivery_mode"
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
    if not _table_exists(conn, "inbound_invoices"):
        return
    if not _column_exists(conn, "inbound_invoices", "purchase_lines"):
        op.add_column("inbound_invoices", sa.Column("purchase_lines", sa.JSON(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "inbound_invoices"):
        return
    if _column_exists(conn, "inbound_invoices", "purchase_lines"):
        op.drop_column("inbound_invoices", "purchase_lines")
