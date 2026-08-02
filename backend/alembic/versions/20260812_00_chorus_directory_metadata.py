"""Add Chorus directory metadata.

Revision ID: 20260812_chorus_dir_meta
Revises: 20260811_default_sales_vat_rate
Create Date: 2026-07-06
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260812_chorus_dir_meta"
down_revision = "20260811_default_sales_vat_rate"
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    conn = op.get_bind()
    return any(column.get("name") == column_name for column in sa.inspect(conn).get_columns(table_name))


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
    _add_column_if_missing("customers", sa.Column("public_service_code", sa.String(), nullable=True))
    _add_column_if_missing("customers", sa.Column("public_commitment_reference", sa.String(), nullable=True))
    _add_column_if_missing("customers", sa.Column("chorus_service_code_required", sa.Boolean(), nullable=True))
    _add_column_if_missing("customers", sa.Column("chorus_commitment_required", sa.Boolean(), nullable=True))
    _add_column_if_missing("customers", sa.Column("chorus_billing_address_active", sa.Boolean(), nullable=True))

    _add_column_if_missing("recipient_directory_entries", sa.Column("routing_code", sa.String(), nullable=True))
    _add_column_if_missing("recipient_directory_entries", sa.Column("routing_identifier", sa.String(), nullable=True))
    _add_column_if_missing("recipient_directory_entries", sa.Column("platform_attached", sa.Boolean(), nullable=True))
    _add_column_if_missing(
        "recipient_directory_entries",
        sa.Column("billing_address_active", sa.Boolean(), nullable=True),
    )
    _add_column_if_missing(
        "recipient_directory_entries",
        sa.Column("service_code_required", sa.Boolean(), nullable=True),
    )
    _add_column_if_missing("recipient_directory_entries", sa.Column("commitment_required", sa.Boolean(), nullable=True))
    _add_column_if_missing("recipient_directory_entries", sa.Column("public_entity", sa.Boolean(), nullable=True))
    _add_column_if_missing("recipient_directory_entries", sa.Column("raw_payload", sa.JSON(), nullable=True))


def downgrade() -> None:
    for column_name in (
        "raw_payload",
        "public_entity",
        "commitment_required",
        "service_code_required",
        "billing_address_active",
        "platform_attached",
        "routing_identifier",
        "routing_code",
    ):
        _drop_column_if_exists("recipient_directory_entries", column_name)
    for column_name in (
        "chorus_billing_address_active",
        "chorus_commitment_required",
        "chorus_service_code_required",
        "public_commitment_reference",
        "public_service_code",
    ):
        _drop_column_if_exists("customers", column_name)
