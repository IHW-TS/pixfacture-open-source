"""Add usage metrics table

Revision ID: 20260524_00
Revises: 20260523_00
Create Date: 2026-05-24
"""

from alembic import op
import sqlalchemy as sa

revision = "20260524_00"
down_revision = "20260523_00"
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
            "usage_metrics",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("period", sa.String(), nullable=False),
            sa.Column("metrics_json", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.UniqueConstraint("tenant_id", "period", name="uniq_usage_metric_per_tenant_period"),
        )
    except Exception:
        pass

    _safe_create_index("ix_usage_metrics_tenant_id", "usage_metrics", ["tenant_id"])
    _safe_create_index("ix_usage_metrics_period", "usage_metrics", ["period"])


def downgrade() -> None:
    try:
        op.drop_index("ix_usage_metrics_period", table_name="usage_metrics")
    except Exception:
        pass
    try:
        op.drop_index("ix_usage_metrics_tenant_id", table_name="usage_metrics")
    except Exception:
        pass
    try:
        op.drop_table("usage_metrics")
    except Exception:
        pass
