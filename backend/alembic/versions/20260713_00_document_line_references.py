"""Add document line references

Revision ID: 20260713_document_line_refs
Revises: 20260712_payment_settlement
Create Date: 2026-05-04
"""

from alembic import op
import sqlalchemy as sa


revision = "20260713_document_line_refs"
down_revision = "20260712_payment_settlement"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    return table_name in sa.inspect(conn).get_table_names()


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    if not _table_exists(conn, table_name):
        return False
    return any(column["name"] == column_name for column in sa.inspect(conn).get_columns(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    for table_name in ("invoice_lines", "quote_lines"):
        if not _column_exists(conn, table_name, "reference"):
            op.add_column(table_name, sa.Column("reference", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    for table_name in ("quote_lines", "invoice_lines"):
        if _column_exists(conn, table_name, "reference"):
            op.drop_column(table_name, "reference")
