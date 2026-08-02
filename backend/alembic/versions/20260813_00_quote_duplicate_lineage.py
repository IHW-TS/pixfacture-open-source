"""Track quote duplicate lineage.

Revision ID: 20260813_quote_duplicate_lineage
Revises: 20260812_chorus_dir_meta
Create Date: 2026-07-07
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260813_quote_duplicate_lineage"
down_revision = "20260812_chorus_dir_meta"
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    conn = op.get_bind()
    return any(column.get("name") == column_name for column in sa.inspect(conn).get_columns(table_name))


def _index_exists(table_name: str, index_name: str) -> bool:
    conn = op.get_bind()
    return any(index.get("name") == index_name for index in sa.inspect(conn).get_indexes(table_name))


def upgrade() -> None:
    if not _column_exists("quotes", "duplicate_of_id"):
        with op.batch_alter_table("quotes") as batch:
            batch.add_column(sa.Column("duplicate_of_id", sa.String(), nullable=True))
    if not _index_exists("quotes", "ix_quotes_duplicate_of_id"):
        op.create_index("ix_quotes_duplicate_of_id", "quotes", ["duplicate_of_id"], unique=False)


def downgrade() -> None:
    if _index_exists("quotes", "ix_quotes_duplicate_of_id"):
        op.drop_index("ix_quotes_duplicate_of_id", table_name="quotes")
    if _column_exists("quotes", "duplicate_of_id"):
        with op.batch_alter_table("quotes") as batch:
            batch.drop_column("duplicate_of_id")
