"""Add is_platform_admin to users

Revision ID: 20260603_00
Revises: 20260602_00
Create Date: 2026-06-03
"""

from alembic import op
import sqlalchemy as sa

revision = "20260603_00"
down_revision = "20260602_00"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("users")}
    if "is_platform_admin" not in existing_columns:
        op.add_column(
            "users",
            sa.Column("is_platform_admin", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        )
        op.execute("UPDATE users SET is_platform_admin = is_admin WHERE is_admin = true")
        op.alter_column("users", "is_platform_admin", server_default=None)


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("users")}
    if "is_platform_admin" in existing_columns:
        op.drop_column("users", "is_platform_admin")
