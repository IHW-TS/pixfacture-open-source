"""Add directory cache fields

Revision ID: 20260510_00
Revises: 20260411_01
Create Date: 2026-05-10
"""

from alembic import op
import sqlalchemy as sa

revision = "20260510_00"
down_revision = "20260411_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    try:
        op.add_column("recipient_directory_entries", sa.Column("last_synced_at", sa.DateTime(), nullable=True))
    except Exception:
        pass
    try:
        op.add_column("recipient_directory_entries", sa.Column("ttl_seconds", sa.Integer(), nullable=True))
    except Exception:
        pass


def downgrade() -> None:
    try:
        op.drop_column("recipient_directory_entries", "ttl_seconds")
    except Exception:
        pass
    try:
        op.drop_column("recipient_directory_entries", "last_synced_at")
    except Exception:
        pass
