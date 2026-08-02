"""Add revoked_at to api_keys

Revision ID: 20260325_21
Revises: 20260320_20
Create Date: 2026-03-25
"""

from alembic import op
import sqlalchemy as sa

revision = "20260325_21"
down_revision = "20260320_20"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("api_keys")}
    if "revoked_at" not in existing_columns:
        op.add_column("api_keys", sa.Column("revoked_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("api_keys")}
    if "revoked_at" in existing_columns:
        op.drop_column("api_keys", "revoked_at")
