"""Add persistent background jobs and scale indexes.

Revision ID: 20260809_scale_jobs_indexes
Revises: 20260808_api_key_read_only
Create Date: 2026-06-20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260809_scale_jobs_indexes"
down_revision = "20260808_api_key_read_only"
branch_labels = None
depends_on = None


def _table_exists(conn, table_name: str) -> bool:
    return table_name in sa.inspect(conn).get_table_names()


def _index_exists(conn, table_name: str, index_name: str) -> bool:
    if not _table_exists(conn, table_name):
        return False
    return any(index.get("name") == index_name for index in sa.inspect(conn).get_indexes(table_name))


def _create_index_if_missing(conn, name: str, table_name: str, columns: list[str], *, unique: bool = False) -> None:
    if _index_exists(conn, table_name, name):
        return
    op.create_index(name, table_name, columns, unique=unique)


def upgrade() -> None:
    conn = op.get_bind()
    if not _table_exists(conn, "background_jobs"):
        op.create_table(
            "background_jobs",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("tenant_id", sa.String(), sa.ForeignKey("tenants.id"), nullable=False),
            sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("type", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False, server_default="queued"),
            sa.Column("queue", sa.String(), nullable=False, server_default="default"),
            sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("input_hash", sa.String(), nullable=True),
            sa.Column("result_ref", sa.String(), nullable=True),
            sa.Column("error_code", sa.String(), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("rq_job_id", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("completed_at", sa.DateTime(), nullable=True),
            sa.Column("expires_at", sa.DateTime(), nullable=True),
        )
    _create_index_if_missing(conn, "ix_background_jobs_tenant_id", "background_jobs", ["tenant_id"])
    _create_index_if_missing(conn, "ix_background_jobs_user_id", "background_jobs", ["user_id"])
    _create_index_if_missing(conn, "ix_background_jobs_type", "background_jobs", ["type"])
    _create_index_if_missing(conn, "ix_background_jobs_status", "background_jobs", ["status"])
    _create_index_if_missing(conn, "ix_background_jobs_queue", "background_jobs", ["queue"])
    _create_index_if_missing(conn, "ix_background_jobs_input_hash", "background_jobs", ["input_hash"])
    _create_index_if_missing(conn, "ix_background_jobs_rq_job_id", "background_jobs", ["rq_job_id"])
    _create_index_if_missing(
        conn,
        "ix_background_jobs_tenant_status_created",
        "background_jobs",
        ["tenant_id", "status", "created_at"],
    )
    _create_index_if_missing(
        conn,
        "ix_background_jobs_tenant_type_created",
        "background_jobs",
        ["tenant_id", "type", "created_at"],
    )
    _create_index_if_missing(
        conn,
        "ix_invoices_tenant_status_due",
        "invoices",
        ["tenant_id", "status", "due_date"],
    )
    _create_index_if_missing(
        conn,
        "ix_quotes_tenant_status_valid_until",
        "quotes",
        ["tenant_id", "status", "valid_until"],
    )
    _create_index_if_missing(
        conn,
        "ix_inbound_invoices_tenant_status_received",
        "inbound_invoices",
        ["tenant_id", "status", "received_at"],
    )
    _create_index_if_missing(
        conn,
        "ix_action_logs_tenant_entity_created",
        "action_logs",
        ["tenant_id", "entity", "entity_id", "created_at"],
    )


def downgrade() -> None:
    conn = op.get_bind()
    for table_name, index_name in (
        ("action_logs", "ix_action_logs_tenant_entity_created"),
        ("inbound_invoices", "ix_inbound_invoices_tenant_status_received"),
        ("quotes", "ix_quotes_tenant_status_valid_until"),
        ("invoices", "ix_invoices_tenant_status_due"),
    ):
        if _index_exists(conn, table_name, index_name):
            op.drop_index(index_name, table_name=table_name)
    if _table_exists(conn, "background_jobs"):
        op.drop_table("background_jobs")
