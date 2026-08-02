"""Add directory sync runs and customer pdp_name

Revision ID: 20260510_01
Revises: 20260510_00
Create Date: 2026-05-10
"""

from alembic import op
import sqlalchemy as sa

revision = "20260510_01"
down_revision = "20260510_00"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_customer_cols = {col["name"] for col in inspector.get_columns("customers")}
    if "pdp_name" not in existing_customer_cols:
        op.add_column("customers", sa.Column("pdp_name", sa.String(), nullable=True))

    existing_tables = set(inspector.get_table_names())
    if "directory_sync_runs" not in existing_tables:
        op.create_table(
            "directory_sync_runs",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False, index=True),
            sa.Column("source", sa.String(), nullable=False, server_default="ppf"),
            sa.Column("status", sa.String(), nullable=False, server_default="running"),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("total_requested", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_found", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_created", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_updated", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_skipped", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_errors", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
        )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = set(inspector.get_table_names())
    if "directory_sync_runs" in existing_tables:
        op.drop_table("directory_sync_runs")

    existing_customer_cols = {col["name"] for col in inspector.get_columns("customers")}
    if "pdp_name" in existing_customer_cols:
        op.drop_column("customers", "pdp_name")
