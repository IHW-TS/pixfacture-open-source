"""Add invoice followup subject default.

Revision ID: 20260810_followup_subject
Revises: 20260809_scale_jobs_indexes
Create Date: 2026-06-22
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260810_followup_subject"
down_revision = "20260809_scale_jobs_indexes"
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    conn = op.get_bind()
    return any(column.get("name") == column_name for column in sa.inspect(conn).get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("tenants", "reminder_subject_default"):
        with op.batch_alter_table("tenants") as batch:
            batch.add_column(sa.Column("reminder_subject_default", sa.Text(), nullable=True))


def downgrade() -> None:
    if _column_exists("tenants", "reminder_subject_default"):
        with op.batch_alter_table("tenants") as batch:
            batch.drop_column("reminder_subject_default")
