"""Add e-reporting events

Revision ID: 20260315_19
Revises: 20260301_18
Create Date: 2026-03-15
"""

from alembic import op
import sqlalchemy as sa

revision = "20260315_19"
down_revision = "20260301_18"
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
            "ereporting_events",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("type", sa.String(), nullable=False),
            sa.Column("amounts", sa.JSON(), nullable=True),
            sa.Column("payment_date", sa.Date(), nullable=True),
            sa.Column("country", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )
    except Exception:
        pass

    _safe_create_index("ix_ereporting_events_tenant_id", "ereporting_events", ["tenant_id"])
    _safe_create_index("ix_ereporting_events_created_at", "ereporting_events", ["created_at"])


def downgrade() -> None:
    try:
        op.drop_index("ix_ereporting_events_created_at", table_name="ereporting_events")
    except Exception:
        pass
    try:
        op.drop_index("ix_ereporting_events_tenant_id", table_name="ereporting_events")
    except Exception:
        pass
    try:
        op.drop_table("ereporting_events")
    except Exception:
        pass
