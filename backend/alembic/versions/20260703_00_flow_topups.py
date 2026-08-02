"""Add flow topups table

Revision ID: 20260703_00
Revises: 20260702_02
Create Date: 2026-01-30
"""

from alembic import op
import sqlalchemy as sa


revision = "20260703_00"
down_revision = "20260702_02"
branch_labels = None
depends_on = None


def _table_exists(conn, name: str) -> bool:
    inspector = sa.inspect(conn)
    return name in inspector.get_table_names()


def _index_exists(conn, table: str, name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(idx["name"] == name for idx in inspector.get_indexes(table))


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "flow_topups"):
        op.create_table(
            "flow_topups",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("period_start", sa.Date(), nullable=False),
            sa.Column("quantity", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        )
    if _table_exists(conn, "flow_topups"):
        if not _index_exists(conn, "flow_topups", "ix_flow_topups_tenant_period"):
            op.create_index("ix_flow_topups_tenant_period", "flow_topups", ["tenant_id", "period_start"])


def downgrade() -> None:
    conn = op.get_bind()
    if _table_exists(conn, "flow_topups"):
        if _index_exists(conn, "flow_topups", "ix_flow_topups_tenant_period"):
            op.drop_index("ix_flow_topups_tenant_period", table_name="flow_topups")
        op.drop_table("flow_topups")
