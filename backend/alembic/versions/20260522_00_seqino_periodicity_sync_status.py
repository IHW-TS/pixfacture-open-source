"""Add tenant seqino periodicity sync status

Revision ID: 20260522_00
Revises: 20260521_00
Create Date: 2026-05-22
"""

from alembic import op
import sqlalchemy as sa

revision = "20260522_00"
down_revision = "20260521_00"
branch_labels = None
depends_on = None


def _column_exists(conn, table: str, column: str) -> bool:
    inspector = sa.inspect(conn)
    return column in {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    conn = op.get_bind()
    if not _column_exists(conn, "tenants", "seqino_last_periodicity_sync_at"):
        op.add_column("tenants", sa.Column("seqino_last_periodicity_sync_at", sa.DateTime(), nullable=True))
    if not _column_exists(conn, "tenants", "seqino_last_periodicity_sync_status"):
        op.add_column("tenants", sa.Column("seqino_last_periodicity_sync_status", sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "tenants", "seqino_last_periodicity_sync_status"):
        op.drop_column("tenants", "seqino_last_periodicity_sync_status")
    if _column_exists(conn, "tenants", "seqino_last_periodicity_sync_at"):
        op.drop_column("tenants", "seqino_last_periodicity_sync_at")
