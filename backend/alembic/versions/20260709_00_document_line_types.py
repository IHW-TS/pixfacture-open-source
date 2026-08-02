"""Add document presentation line types

Revision ID: 20260709_00_document_line_types
Revises: 20260708_00
Create Date: 2026-04-25
"""

from alembic import op
import sqlalchemy as sa


revision = "20260709_00_document_line_types"
down_revision = "20260708_00"
branch_labels = None
depends_on = None


def _has_column(conn, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    for table_name in ("invoice_lines", "quote_lines"):
        if not _has_column(conn, table_name, "line_type"):
            op.add_column(
                table_name,
                sa.Column("line_type", sa.String(), nullable=False, server_default="item"),
            )
            op.alter_column(table_name, "line_type", server_default=None)
        if not _has_column(conn, table_name, "detail"):
            op.add_column(table_name, sa.Column("detail", sa.Text(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    for table_name in ("quote_lines", "invoice_lines"):
        if _has_column(conn, table_name, "detail"):
            op.drop_column(table_name, "detail")
        if _has_column(conn, table_name, "line_type"):
            op.drop_column(table_name, "line_type")
