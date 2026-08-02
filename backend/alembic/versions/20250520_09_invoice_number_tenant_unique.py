"""Make invoice numbers unique per tenant

Revision ID: 20250520_09
Revises: 20250501_08
Create Date: 2025-05-20
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20250520_09"
down_revision = "20250501_08"
branch_labels = None
depends_on = None


def _drop_unique_constraint(conn, name: str) -> None:
    if conn.dialect.name == "postgresql":
        conn.execute(sa.text(f"ALTER TABLE invoices DROP CONSTRAINT IF EXISTS {name}"))
        return
    op.drop_constraint(name, "invoices", type_="unique")


def _get_table_names(conn) -> set[str]:
    inspector = sa.inspect(conn)
    return set(inspector.get_table_names())


def _add_unique_constraint_if_missing(conn) -> None:
    if conn.dialect.name == "postgresql":
        op.execute(
            """
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'uq_invoices_tenant_number'
              ) THEN
                ALTER TABLE invoices
                ADD CONSTRAINT uq_invoices_tenant_number UNIQUE (tenant_id, number);
              END IF;
            END
            $$;
            """
        )
        return
    op.create_unique_constraint("uq_invoices_tenant_number", "invoices", ["tenant_id", "number"])


def _add_index_if_missing(conn) -> None:
    if conn.dialect.name == "postgresql":
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_invoices_tenant_number ON invoices (tenant_id, number)"
        )
        return
    op.create_index("ix_invoices_tenant_number", "invoices", ["tenant_id", "number"])


def upgrade() -> None:
    conn = op.get_bind()
    if "invoices" not in _get_table_names(conn):
        return

    for name in ("invoices_number_key", "uniq_invoice_number_per_tenant"):
        _drop_unique_constraint(conn, name)

    _add_unique_constraint_if_missing(conn)
    _add_index_if_missing(conn)


def downgrade() -> None:
    conn = op.get_bind()

    if "invoices" not in _get_table_names(conn):
        return

    if conn.dialect.name == "postgresql":
        op.execute("DROP INDEX IF EXISTS ix_invoices_tenant_number")
    else:
        op.drop_index("ix_invoices_tenant_number", table_name="invoices")

    _drop_unique_constraint(conn, "uq_invoices_tenant_number")
    op.create_unique_constraint("invoices_number_key", "invoices", ["number"])
