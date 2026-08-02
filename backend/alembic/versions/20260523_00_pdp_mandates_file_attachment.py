"""Add file attachment to pdp mandates

Revision ID: 20260523_00
Revises: 20260522_00
Create Date: 2026-05-23
"""

from alembic import op
import sqlalchemy as sa

revision = "20260523_00"
down_revision = "20260522_00"
branch_labels = None
depends_on = None


def _safe_add_column(table: str, column: sa.Column) -> None:
    try:
        op.add_column(table, column)
    except Exception:
        pass


def upgrade() -> None:
    _safe_add_column("pdp_mandates", sa.Column("file_attachment", sa.JSON(), nullable=True))


def downgrade() -> None:
    try:
        op.drop_column("pdp_mandates", "file_attachment")
    except Exception:
        pass
