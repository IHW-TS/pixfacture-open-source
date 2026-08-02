"""Add einvoicing events table

Revision ID: 20260410_01
Revises: 20260406_01
Create Date: 2026-04-10
"""

from alembic import op
import sqlalchemy as sa

revision = "20260410_01"
down_revision = "20260406_01"
branch_labels = None
depends_on = None


def _safe_create_index(name: str, table: str, columns: list[str]) -> None:
    try:
        op.create_index(name, table, columns)
    except Exception:
        pass


def upgrade() -> None:
    try:
        op.create_table(
            "einvoicing_events",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("transmission_id", sa.String(), sa.ForeignKey("einvoicing_transmissions.id"), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("message", sa.Text(), nullable=True),
            sa.Column("raw_status", sa.String(), nullable=True),
            sa.Column("errors", sa.JSON(), nullable=True),
            sa.Column("source", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )
    except Exception:
        pass

    _safe_create_index("ix_einvoicing_events_tenant_id", "einvoicing_events", ["tenant_id"])
    _safe_create_index("ix_einvoicing_events_transmission_id", "einvoicing_events", ["transmission_id"])


def downgrade() -> None:
    try:
        op.drop_index("ix_einvoicing_events_transmission_id", table_name="einvoicing_events")
    except Exception:
        pass
    try:
        op.drop_index("ix_einvoicing_events_tenant_id", table_name="einvoicing_events")
    except Exception:
        pass
    try:
        op.drop_table("einvoicing_events")
    except Exception:
        pass
