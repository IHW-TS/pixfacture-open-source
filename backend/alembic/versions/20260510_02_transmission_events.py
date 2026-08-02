"""Add transmission events table

Revision ID: 20260510_02
Revises: 20260510_01
Create Date: 2026-05-10
"""

from alembic import op
import sqlalchemy as sa

revision = "20260510_02"
down_revision = "20260510_01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    try:
        op.create_table(
            "transmission_events",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("transmission_id", sa.String(), sa.ForeignKey("einvoicing_transmissions.id"), nullable=False, index=True),
            sa.Column("event_type", sa.String(), nullable=False),
            sa.Column("status_code_norme", sa.String(), nullable=False),
            sa.Column("payload_raw", sa.JSON(), nullable=True),
            sa.Column("occurred_at", sa.DateTime(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
        )
    except Exception:
        pass


def downgrade() -> None:
    try:
        op.drop_table("transmission_events")
    except Exception:
        pass
