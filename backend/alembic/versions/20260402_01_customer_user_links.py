"""Add customer user links

Revision ID: 20260402_01
Revises: 20260402_00
Create Date: 2026-04-02
"""

from alembic import op
import sqlalchemy as sa

revision = "20260402_01"
down_revision = "20260402_00"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_user_invites_cols = {col["name"] for col in inspector.get_columns("user_invites")}
    existing_user_invites_indexes = {idx["name"] for idx in inspector.get_indexes("user_invites")}
    if "customer_id" not in existing_user_invites_cols:
        op.add_column(
            "user_invites",
            sa.Column("customer_id", sa.String(), nullable=True),
        )
    if "ix_user_invites_customer_id" not in existing_user_invites_indexes:
        op.create_index("ix_user_invites_customer_id", "user_invites", ["customer_id"])

    existing_tables = set(inspector.get_table_names())
    if "customer_user_links" not in existing_tables:
        op.create_table(
            "customer_user_links",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("customer_id", sa.String(), sa.ForeignKey("customers.id"), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
            sa.UniqueConstraint("tenant_id", "user_id", name="uniq_customer_user_link"),
        )
        op.create_index("ix_customer_user_links_tenant_id", "customer_user_links", ["tenant_id"])
        op.create_index("ix_customer_user_links_user_id", "customer_user_links", ["user_id"])
        op.create_index("ix_customer_user_links_customer_id", "customer_user_links", ["customer_id"])


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_tables = set(inspector.get_table_names())
    if "customer_user_links" in existing_tables:
        existing_indexes = {idx["name"] for idx in inspector.get_indexes("customer_user_links")}
        if "ix_customer_user_links_customer_id" in existing_indexes:
            op.drop_index("ix_customer_user_links_customer_id", table_name="customer_user_links")
        if "ix_customer_user_links_user_id" in existing_indexes:
            op.drop_index("ix_customer_user_links_user_id", table_name="customer_user_links")
        if "ix_customer_user_links_tenant_id" in existing_indexes:
            op.drop_index("ix_customer_user_links_tenant_id", table_name="customer_user_links")
        op.drop_table("customer_user_links")

    existing_user_invites_cols = {col["name"] for col in inspector.get_columns("user_invites")}
    existing_user_invites_indexes = {idx["name"] for idx in inspector.get_indexes("user_invites")}
    if "ix_user_invites_customer_id" in existing_user_invites_indexes:
        op.drop_index("ix_user_invites_customer_id", table_name="user_invites")
    if "customer_id" in existing_user_invites_cols:
        op.drop_column("user_invites", "customer_id")
