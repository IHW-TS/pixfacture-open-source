"""inbound invoice attachment size bytes

Revision ID: 20260804_inbound_attachment_size
Revises: 20260803_invoice_line_source
Create Date: 2026-06-09
"""

from alembic import op
import sqlalchemy as sa


revision = "20260804_inbound_attachment_size"
down_revision = "20260803_invoice_line_source"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    inspector = sa.inspect(conn)
    return table_name in inspector.get_table_names()


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(column.get("name") == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "inbound_invoice_attachments"):
        return
    if not _column_exists(conn, "inbound_invoice_attachments", "size_bytes"):
        op.add_column(
            "inbound_invoice_attachments",
            sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "inbound_invoice_attachments") and _column_exists(
        conn, "inbound_invoice_attachments", "size_bytes"
    ):
        op.drop_column("inbound_invoice_attachments", "size_bytes")
