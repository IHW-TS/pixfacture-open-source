"""Add source line tracking for partial credit notes.

Revision ID: 20260803_invoice_line_source
Revises: 20260802_purchase_payments
Create Date: 2026-06-08
"""

from alembic import op
import sqlalchemy as sa


revision = "20260803_invoice_line_source"
down_revision = "20260802_purchase_payments"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    inspector = sa.inspect(conn)
    return table_name in inspector.get_table_names()


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    if not _table_exists(conn, table_name):
        return False
    inspector = sa.inspect(conn)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def _index_exists(conn, table_name: str, index_name: str) -> bool:
    if not _table_exists(conn, table_name):
        return False
    inspector = sa.inspect(conn)
    return any(index.get("name") == index_name for index in inspector.get_indexes(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        op.execute("ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS source_line_id VARCHAR")
        op.execute("CREATE INDEX IF NOT EXISTS ix_invoice_lines_source_line_id ON invoice_lines (source_line_id)")
        return

    if _table_exists(conn, "invoice_lines") and not _column_exists(conn, "invoice_lines", "source_line_id"):
        op.add_column("invoice_lines", sa.Column("source_line_id", sa.String(), nullable=True))
    if _table_exists(conn, "invoice_lines") and not _index_exists(
        conn, "invoice_lines", "ix_invoice_lines_source_line_id"
    ):
        op.create_index("ix_invoice_lines_source_line_id", "invoice_lines", ["source_line_id"])


def downgrade() -> None:
    conn = op.get_bind()
    if conn.dialect.name == "postgresql":
        op.execute("DROP INDEX IF EXISTS ix_invoice_lines_source_line_id")
        op.execute("ALTER TABLE invoice_lines DROP COLUMN IF EXISTS source_line_id")
        return

    if _index_exists(conn, "invoice_lines", "ix_invoice_lines_source_line_id"):
        op.drop_index("ix_invoice_lines_source_line_id", table_name="invoice_lines")
    if _column_exists(conn, "invoice_lines", "source_line_id"):
        op.drop_column("invoice_lines", "source_line_id")
