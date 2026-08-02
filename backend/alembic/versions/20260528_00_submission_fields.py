"""Add submission tracking fields

Revision ID: 20260528_00
Revises: 20260527_00
Create Date: 2026-05-28
"""

from alembic import op
import sqlalchemy as sa

revision = "20260528_00"
down_revision = "20260527_00"
branch_labels = None
depends_on = None


def _index_exists(conn, table: str, name: str) -> bool:
    inspector = sa.inspect(conn)
    return name in {idx["name"] for idx in inspector.get_indexes(table)}


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("submissions")}
    if "message_id" not in existing_columns:
        op.add_column("submissions", sa.Column("message_id", sa.String(), nullable=True))
    if "errors" not in existing_columns:
        op.add_column("submissions", sa.Column("errors", sa.JSON(), nullable=True))
    if not _index_exists(conn, "submissions", "ix_submissions_message_id"):
        op.create_index("ix_submissions_message_id", "submissions", ["message_id"])


def downgrade() -> None:
    try:
        op.drop_index("ix_submissions_message_id", table_name="submissions")
    except Exception:
        pass
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {col["name"] for col in inspector.get_columns("submissions")}
    if "errors" in existing_columns:
        op.drop_column("submissions", "errors")
    if "message_id" in existing_columns:
        op.drop_column("submissions", "message_id")
