"""Add action log metadata column

Revision ID: 20260701_04
Revises: 20260701_03
Create Date: 2026-01-28
"""

from alembic import op
import sqlalchemy as sa


revision = "20260701_04"
down_revision = "20260701_03"
branch_labels = None
depends_on = None


def _table_exists(conn, table: str) -> bool:
    inspector = sa.inspect(conn)
    return table in inspector.get_table_names()


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    if table not in inspector.get_table_names():
        return False
    columns = {col["name"] for col in inspector.get_columns(table)}
    return column in columns


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "action_logs"):
        return
    if _column_exists(conn, "action_logs", "metadata"):
        return
    op.add_column("action_logs", sa.Column("metadata", sa.JSON(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "action_logs"):
        return
    if not _column_exists(conn, "action_logs", "metadata"):
        return
    op.drop_column("action_logs", "metadata")
