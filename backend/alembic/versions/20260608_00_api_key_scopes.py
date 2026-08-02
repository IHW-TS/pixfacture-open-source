"""Add scopes to api keys

Revision ID: 20260608_00
Revises: 20260607_00
Create Date: 2026-06-08
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260608_00"
down_revision = "20260607_00"
branch_labels = None
depends_on = None

DEFAULT_SCOPES = [
    "read:invoices",
    "write:invoices",
    "read:customers",
    "write:customers",
    "read:jobs",
]


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def _json_type():
    return sa.JSON().with_variant(postgresql.JSONB, "postgresql")


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "api_keys", "scopes"):
        op.add_column("api_keys", sa.Column("scopes", _json_type(), nullable=True))
    api_keys = sa.table("api_keys", sa.column("scopes", _json_type()))
    op.execute(
        api_keys.update()
        .where(api_keys.c.scopes.is_(None))
        .values(scopes=DEFAULT_SCOPES)
    )


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "api_keys", "scopes"):
        op.drop_column("api_keys", "scopes")
