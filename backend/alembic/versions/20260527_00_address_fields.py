"""Add structured address fields for tenants and customers.

Revision ID: 20260527_00
Revises: 20260526_00
Create Date: 2026-05-27
"""

from alembic import op
import sqlalchemy as sa

revision = "20260527_00"
down_revision = "20260526_00"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    for table in ("tenants", "customers"):
        existing_columns = {col["name"] for col in inspector.get_columns(table)}
        for name in ("address_line1", "address_line2", "postal_code", "city", "country_code"):
            if name not in existing_columns:
                op.add_column(table, sa.Column(name, sa.String(), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    for table in ("tenants", "customers"):
        existing_columns = {col["name"] for col in inspector.get_columns(table)}
        for name in ("country_code", "city", "postal_code", "address_line2", "address_line1"):
            if name in existing_columns:
                op.drop_column(table, name)
