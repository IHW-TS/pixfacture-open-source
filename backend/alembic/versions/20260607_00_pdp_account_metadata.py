"""Add provider metadata to pdp accounts

Revision ID: 20260607_00
Revises: 20260606_00
Create Date: 2026-06-07
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260607_00"
down_revision = "20260606_00"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def _index_exists(conn, table: str, name: str) -> bool:
    inspector = sa.inspect(conn)
    return any(idx["name"] == name for idx in inspector.get_indexes(table))


def _json_type():
    return sa.JSON().with_variant(postgresql.JSONB, "postgresql")


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "pdp_accounts", "provider_metadata"):
        op.add_column("pdp_accounts", sa.Column("provider_metadata", _json_type(), nullable=True))
    if not _index_exists(conn, "pdp_accounts", "ix_pdp_accounts_updated_at"):
        op.create_index("ix_pdp_accounts_updated_at", "pdp_accounts", ["updated_at"])


def downgrade() -> None:
    conn = op.get_bind()
    if _index_exists(conn, "pdp_accounts", "ix_pdp_accounts_updated_at"):
        op.drop_index("ix_pdp_accounts_updated_at", table_name="pdp_accounts")
    if _column_exists(conn, "pdp_accounts", "provider_metadata"):
        op.drop_column("pdp_accounts", "provider_metadata")
