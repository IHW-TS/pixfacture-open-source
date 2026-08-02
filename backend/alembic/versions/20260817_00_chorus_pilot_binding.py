"""Add durable Chorus pilot qualification fields.

Revision ID: 20260817_chorus_pilot_binding
Revises: 20260816_demo_invitations
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260817_chorus_pilot_binding"
down_revision = "20260816_demo_invitations"
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    return any(
        column.get("name") == column_name
        for column in sa.inspect(op.get_bind()).get_columns(table_name)
    )


def _add_column_if_missing(table_name: str, column: sa.Column) -> None:
    if _column_exists(table_name, column.name):
        return
    with op.batch_alter_table(table_name) as batch:
        batch.add_column(column)


def _drop_column_if_exists(table_name: str, column_name: str) -> None:
    if not _column_exists(table_name, column_name):
        return
    with op.batch_alter_table(table_name) as batch:
        batch.drop_column(column_name)


def upgrade() -> None:
    _add_column_if_missing("invoices", sa.Column("public_service_code", sa.String(), nullable=True))
    _add_column_if_missing("pdp_connections", sa.Column("verified_siret", sa.String(), nullable=True))
    _add_column_if_missing("pdp_connections", sa.Column("verified_structure_id", sa.String(), nullable=True))
    _add_column_if_missing("pdp_connections", sa.Column("verified_at", sa.DateTime(), nullable=True))
    _add_column_if_missing(
        "recipient_directory_entries",
        sa.Column("service_or_commitment_required", sa.Boolean(), nullable=True),
    )
    op.execute(
        "UPDATE pdp_connections SET status = 'disconnected' "
        "WHERE lower(provider_slug) IN ('chorus', 'choruspro') "
        "AND lower(coalesce(status, '')) = 'connected' AND verified_siret IS NULL"
    )
    with op.batch_alter_table("pdp_connections") as batch:
        batch.alter_column("status", server_default="disconnected", existing_type=sa.String())


def downgrade() -> None:
    with op.batch_alter_table("pdp_connections") as batch:
        batch.alter_column("status", server_default="connected", existing_type=sa.String())
    _drop_column_if_exists("recipient_directory_entries", "service_or_commitment_required")
    _drop_column_if_exists("pdp_connections", "verified_at")
    _drop_column_if_exists("pdp_connections", "verified_structure_id")
    _drop_column_if_exists("pdp_connections", "verified_siret")
    _drop_column_if_exists("invoices", "public_service_code")
