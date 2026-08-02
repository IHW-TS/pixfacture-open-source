"""Add delivery address differs flag

Revision ID: 20260411_01
Revises: 20260410_03
Create Date: 2026-04-11
"""

from alembic import op
import sqlalchemy as sa

revision = "20260411_01"
down_revision = "20260410_03"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "invoices", "delivery_address_differs"):
        op.add_column(
            "invoices",
            sa.Column(
                "delivery_address_differs",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "invoices", "delivery_address_differs"):
        op.drop_column("invoices", "delivery_address_differs")
