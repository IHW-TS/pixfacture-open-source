"""Make invoice_artifacts data nullable and add storage_key

Revision ID: 20260610_00
Revises: 20260609_00
Create Date: 2026-06-10
"""

from alembic import op
import sqlalchemy as sa


revision = "20260610_00"
down_revision = "20260609_00"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def _table_exists(conn, table: str) -> bool:
    inspector = sa.inspect(conn)
    return table in inspector.get_table_names()


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "invoice_artifacts"):
        return
    if not _column_exists(conn, "invoice_artifacts", "storage_key"):
        op.add_column("invoice_artifacts", sa.Column("storage_key", sa.String(), nullable=True))
    if _column_exists(conn, "invoice_artifacts", "data"):
        op.alter_column(
            "invoice_artifacts",
            "data",
            existing_type=sa.LargeBinary(),
            nullable=True,
        )


def downgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "invoice_artifacts"):
        return
    if _column_exists(conn, "invoice_artifacts", "data"):
        op.alter_column(
            "invoice_artifacts",
            "data",
            existing_type=sa.LargeBinary(),
            nullable=False,
        )
    if _column_exists(conn, "invoice_artifacts", "storage_key"):
        op.drop_column("invoice_artifacts", "storage_key")
