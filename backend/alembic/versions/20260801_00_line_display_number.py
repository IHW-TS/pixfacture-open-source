"""Add displayed line numbers to documents.

Revision ID: 20260801_line_display_number
Revises: 20260731_customer_internal_note
Create Date: 2026-08-01 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260801_line_display_number"
down_revision = "20260731_customer_internal_note"
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
    for table_name in ("invoice_lines", "quote_lines"):
        if _table_exists(conn, table_name) and not _column_exists(conn, table_name, "display_number"):
            op.add_column(table_name, sa.Column("display_number", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    for table_name in ("quote_lines", "invoice_lines"):
        if _table_exists(conn, table_name) and _column_exists(conn, table_name, "display_number"):
            op.drop_column(table_name, "display_number")
