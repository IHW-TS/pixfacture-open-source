"""Rename endpoints table for recipient directory

Revision ID: 20260402_00
Revises: 20260401_23
Create Date: 2026-04-02
"""

from alembic import op
import sqlalchemy as sa

revision = "20260402_00"
down_revision = "20260401_23"
branch_labels = None
depends_on = None


def upgrade() -> None:
    try:
        op.rename_table("einvoicing_endpoints", "recipient_directory_entries")
    except Exception:
        pass
    try:
        op.alter_column("recipient_directory_entries", "platform", new_column_name="platform_slug")
    except Exception:
        pass
    try:
        op.alter_column("recipient_directory_entries", "address", new_column_name="billing_address")
    except Exception:
        pass
    try:
        op.add_column(
            "recipient_directory_entries",
            sa.Column("source", sa.String(), nullable=True, server_default="manual"),
        )
    except Exception:
        pass


def downgrade() -> None:
    try:
        op.drop_column("recipient_directory_entries", "source")
    except Exception:
        pass
    try:
        op.alter_column("recipient_directory_entries", "platform_slug", new_column_name="platform")
    except Exception:
        pass
    try:
        op.alter_column("recipient_directory_entries", "billing_address", new_column_name="address")
    except Exception:
        pass
    try:
        op.rename_table("recipient_directory_entries", "einvoicing_endpoints")
    except Exception:
        pass
