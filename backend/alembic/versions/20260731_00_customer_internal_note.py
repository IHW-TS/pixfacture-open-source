"""Add customer internal note.

Revision ID: 20260731_customer_internal_note
Revises: 20260730_customer_bank_details
Create Date: 2026-07-31 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260731_customer_internal_note"
down_revision = "20260730_customer_bank_details"
branch_labels = None
depends_on = None


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    return bool(
        conn.execute(
            sa.text(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = :table_name
                  AND column_name = :column_name
                """
            ),
            {"table_name": table_name, "column_name": column_name},
        ).first()
    )


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "customers", "internal_note"):
        op.add_column("customers", sa.Column("internal_note", sa.Text(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "customers", "internal_note"):
        op.drop_column("customers", "internal_note")
