"""Add accounting export cabinet comments

Revision ID: 20260724_export_comments
Revises: 20260723_purchase_lines
Create Date: 2026-07-24 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260724_export_comments"
down_revision = "20260723_purchase_lines"
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
    if not _table_exists(conn, "accounting_exports"):
        return
    if not _column_exists(conn, "accounting_exports", "cabinet_comment"):
        op.add_column("accounting_exports", sa.Column("cabinet_comment", sa.Text(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "accounting_exports"):
        return
    if _column_exists(conn, "accounting_exports", "cabinet_comment"):
        op.drop_column("accounting_exports", "cabinet_comment")
