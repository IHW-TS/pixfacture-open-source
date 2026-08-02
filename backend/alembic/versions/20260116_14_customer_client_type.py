"""Add customer client_type

Revision ID: 20260116_14
Revises: 20260116_13
Create Date: 2026-01-16
"""

from alembic import op
import sqlalchemy as sa

revision = "20260116_14"
down_revision = "20260116_13"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("customers")}
    if "client_type" not in existing_columns:
        op.add_column(
            "customers",
            sa.Column("client_type", sa.String(), nullable=True, server_default="business"),
        )
        op.execute("UPDATE customers SET client_type = 'business' WHERE client_type IS NULL")
        op.alter_column("customers", "client_type", server_default=None)
    else:
        op.execute("UPDATE customers SET client_type = 'business' WHERE client_type IS NULL")


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("customers")}
    if "client_type" in existing_columns:
        op.drop_column("customers", "client_type")
