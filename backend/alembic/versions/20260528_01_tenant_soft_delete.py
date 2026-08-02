"""Add tenant soft-delete fields

Revision ID: 20260528_01
Revises: 20260528_00
Create Date: 2026-05-28
"""

from alembic import op
import sqlalchemy as sa

revision = "20260528_01"
down_revision = "20260528_00"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("tenants")}
    if "deleted_at" not in existing_columns:
        op.add_column("tenants", sa.Column("deleted_at", sa.DateTime(), nullable=True))
    if "deleted_reason" not in existing_columns:
        op.add_column("tenants", sa.Column("deleted_reason", sa.Text(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("tenants")}
    if "deleted_reason" in existing_columns:
        op.drop_column("tenants", "deleted_reason")
    if "deleted_at" in existing_columns:
        op.drop_column("tenants", "deleted_at")
