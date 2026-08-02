"""Add raw column to submissions

Revision ID: 20260602_00
Revises: 20260601_00
Create Date: 2026-06-02
"""

from alembic import op
import sqlalchemy as sa

revision = "20260602_00"
down_revision = "20260601_00"
branch_labels = None
depends_on = None


def upgrade() -> None:
    try:
        op.add_column("submissions", sa.Column("raw", sa.JSON(), nullable=True))
    except Exception:
        pass


def downgrade() -> None:
    try:
        op.drop_column("submissions", "raw")
    except Exception:
        pass
