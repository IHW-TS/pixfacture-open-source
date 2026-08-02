"""Add status column to users

Revision ID: 20260405_03
Revises: 20260403_02
Create Date: 2026-04-05
"""

from alembic import op
import sqlalchemy as sa


revision = "20260405_03"
down_revision = "20260403_02"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "users", "status"):
        op.add_column(
            "users",
            sa.Column("status", sa.String(), nullable=False, server_default="active"),
        )


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "users", "status"):
        op.drop_column("users", "status")
