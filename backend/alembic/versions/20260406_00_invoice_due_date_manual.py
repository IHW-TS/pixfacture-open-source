"""Add due_date_manual to invoices

Revision ID: 20260406_00
Revises: 20260405_03
Create Date: 2026-04-06
"""

from alembic import op
import sqlalchemy as sa


revision = "20260406_00"
down_revision = "20260405_03"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "invoices", "due_date_manual"):
        op.add_column(
            "invoices",
            sa.Column(
                "due_date_manual",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "invoices", "due_date_manual"):
        op.drop_column("invoices", "due_date_manual")
