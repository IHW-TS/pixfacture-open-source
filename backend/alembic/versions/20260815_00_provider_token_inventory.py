"""Add provider token collateral inventory and public billing safeguards.

Revision ID: 20260815_provider_token_pool
Revises: 20260814_chorus_outbox
"""

from alembic import op
import sqlalchemy as sa


revision = "20260815_provider_token_pool"
down_revision = "20260814_chorus_outbox"
branch_labels = None
depends_on = None


_AUDIT_TRIGGER_FUNCTION = "prevent_provider_token_audit_mutation"
_AUDIT_VALIDATE_FUNCTION = "validate_provider_token_double_entry"


def upgrade() -> None:
    # Preserve legacy acceptance rows as historical evidence while binding all
    # future proofs to the exact published document and to the actor's tenant
    # authority at acceptance time. Legacy rows intentionally remain NULL and
    # are therefore never treated as a current DPA acceptance by the service.
    op.add_column(
        "legal_acceptances",
        sa.Column("acceptance_scope", sa.String(), nullable=True),
    )
    op.add_column(
        "legal_acceptances",
        sa.Column("accepted_role", sa.String(), nullable=True),
    )
    op.add_column(
        "legal_acceptances",
        sa.Column("authority_basis", sa.String(), nullable=True),
    )
    op.add_column(
        "legal_acceptances",
        sa.Column("document_sha256", sa.String(length=64), nullable=True),
    )
    op.drop_constraint(
        "uniq_legal_acceptance",
        "legal_acceptances",
        type_="unique",
    )
    op.create_unique_constraint(
        "uniq_legal_acceptance_document_hash",
        "legal_acceptances",
        [
            "tenant_id",
            "user_id",
            "doc_slug",
            "doc_version",
            "document_sha256",
        ],
    )
    op.create_check_constraint(
        "ck_legal_acceptance_scope",
        "legal_acceptances",
        "acceptance_scope IS NULL OR acceptance_scope IN ('user', 'tenant')",
    )
    op.create_check_constraint(
        "ck_legal_acceptance_authority_basis",
        "legal_acceptances",
        "authority_basis IS NULL OR authority_basis IN ('user_self', 'tenant_role')",
    )
    op.create_check_constraint(
        "ck_legal_acceptance_document_sha256_length",
        "legal_acceptances",
        "document_sha256 IS NULL OR char_length(document_sha256) = 64",
    )

    op.add_column(
        "tenants",
        sa.Column("professional_use_confirmed_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "tenants",
        sa.Column("professional_use_confirmed_by", sa.String(), nullable=True),
    )
    op.add_column(
        "tenants",
        sa.Column("stripe_subscription_event_created", sa.Integer(), nullable=True),
    )
    op.add_column(
        "tenants",
        sa.Column("stripe_subscription_event_id", sa.String(), nullable=True),
    )
    op.add_column("tenants", sa.Column("stripe_checkout_session_id", sa.String(), nullable=True))
    op.add_column("tenants", sa.Column("stripe_checkout_request_key", sa.String(), nullable=True))
    op.add_column("tenants", sa.Column("stripe_checkout_pending_until", sa.DateTime(), nullable=True))
    op.add_column("tenants", sa.Column("stripe_checkout_plan", sa.String(), nullable=True))
    op.add_column("tenants", sa.Column("stripe_checkout_period", sa.String(), nullable=True))
    op.create_foreign_key(
        "fk_tenants_professional_use_confirmed_by_users",
        "tenants",
        "users",
        ["professional_use_confirmed_by"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_table(
        "provider_token_inventories",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("provider_slug", sa.String(), nullable=False),
        sa.Column("purchased_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("available_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reserved_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("allocated_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("consumed_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("warning_threshold", sa.Integer(), nullable=False, server_default="1000"),
        sa.Column("critical_threshold", sa.Integer(), nullable=False, server_default="250"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("purchased_tokens >= 0", name="ck_provider_inventory_purchased_nonnegative"),
        sa.CheckConstraint("available_tokens >= 0", name="ck_provider_inventory_available_nonnegative"),
        sa.CheckConstraint("reserved_tokens >= 0", name="ck_provider_inventory_reserved_nonnegative"),
        sa.CheckConstraint("allocated_tokens >= 0", name="ck_provider_inventory_allocated_nonnegative"),
        sa.CheckConstraint("consumed_tokens >= 0", name="ck_provider_inventory_consumed_nonnegative"),
        sa.CheckConstraint("critical_threshold >= 0", name="ck_provider_inventory_critical_nonnegative"),
        sa.CheckConstraint(
            "warning_threshold >= critical_threshold",
            name="ck_provider_inventory_threshold_order",
        ),
        sa.CheckConstraint(
            "purchased_tokens = available_tokens + reserved_tokens + allocated_tokens + consumed_tokens",
            name="ck_provider_inventory_conservation",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider_slug", name="uniq_provider_token_inventory_provider"),
    )
    op.create_table(
        "provider_token_reservations",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("inventory_id", sa.String(), nullable=False),
        sa.Column("tenant_id", sa.String(), nullable=False),
        sa.Column("idempotency_key", sa.String(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="reserved"),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("stripe_checkout_session_id", sa.String(), nullable=True),
        sa.Column("stripe_checkout_kind", sa.String(), nullable=True),
        sa.Column("stripe_checkout_bound_at", sa.DateTime(), nullable=True),
        sa.Column("finalized_at", sa.DateTime(), nullable=True),
        sa.Column("released_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("quantity > 0", name="ck_provider_token_reservation_quantity"),
        sa.CheckConstraint(
            "status IN ('reserved', 'finalized', 'released', 'expired')",
            name="ck_provider_token_reservation_status",
        ),
        sa.ForeignKeyConstraint(["inventory_id"], ["provider_token_inventories.id"]),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "inventory_id",
            "tenant_id",
            "idempotency_key",
            name="uniq_provider_token_reservation_idempotency",
        ),
        sa.UniqueConstraint(
            "stripe_checkout_session_id",
            name="uniq_provider_token_reservation_checkout_session",
        ),
    )
    op.create_index(
        "ix_provider_token_reservations_expiry",
        "provider_token_reservations",
        ["inventory_id", "status", "expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_provider_token_reservations_tenant",
        "provider_token_reservations",
        ["tenant_id", "status"],
        unique=False,
    )

    op.create_table(
        "provider_token_allocations",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("inventory_id", sa.String(), nullable=False),
        sa.Column("tenant_id", sa.String(), nullable=False),
        sa.Column("reservation_id", sa.String(), nullable=True),
        sa.Column("idempotency_key", sa.String(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("available_tokens", sa.Integer(), nullable=False),
        sa.Column("consumed_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("released_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("quantity > 0", name="ck_provider_token_allocation_quantity"),
        sa.CheckConstraint("available_tokens >= 0", name="ck_provider_token_allocation_available"),
        sa.CheckConstraint("consumed_tokens >= 0", name="ck_provider_token_allocation_consumed"),
        sa.CheckConstraint("released_tokens >= 0", name="ck_provider_token_allocation_released"),
        sa.CheckConstraint(
            "quantity = available_tokens + consumed_tokens + released_tokens",
            name="ck_provider_token_allocation_conservation",
        ),
        sa.ForeignKeyConstraint(["inventory_id"], ["provider_token_inventories.id"]),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(["reservation_id"], ["provider_token_reservations.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("reservation_id", name="uniq_provider_token_allocation_reservation"),
        sa.UniqueConstraint(
            "inventory_id",
            "tenant_id",
            "idempotency_key",
            name="uniq_provider_token_allocation_idempotency",
        ),
    )
    op.create_index(
        "ix_provider_token_allocations_tenant",
        "provider_token_allocations",
        ["inventory_id", "tenant_id", "created_at"],
        unique=False,
    )

    op.create_table(
        "provider_token_ledger_events",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("inventory_id", sa.String(), nullable=False),
        sa.Column("tenant_id", sa.String(), nullable=True),
        sa.Column("allocation_id", sa.String(), nullable=True),
        sa.Column("reversal_of_event_id", sa.String(), nullable=True),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("idempotency_key", sa.String(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("reference_type", sa.String(), nullable=True),
        sa.Column("reference_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("quantity > 0", name="ck_provider_token_ledger_event_quantity"),
        sa.ForeignKeyConstraint(["inventory_id"], ["provider_token_inventories.id"]),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(["allocation_id"], ["provider_token_allocations.id"]),
        sa.ForeignKeyConstraint(
            ["reversal_of_event_id"],
            ["provider_token_ledger_events.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "inventory_id",
            "idempotency_key",
            name="uniq_provider_token_ledger_event_idempotency",
        ),
    )
    op.create_index(
        "ix_provider_token_ledger_events_inventory_created",
        "provider_token_ledger_events",
        ["inventory_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_provider_token_ledger_events_tenant_created",
        "provider_token_ledger_events",
        ["tenant_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_provider_token_ledger_events_reversal",
        "provider_token_ledger_events",
        ["reversal_of_event_id"],
        unique=False,
    )

    op.create_table(
        "provider_token_ledger_entries",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("inventory_id", sa.String(), nullable=False),
        sa.Column("entry_index", sa.Integer(), nullable=False),
        sa.Column("account", sa.String(), nullable=False),
        sa.Column("delta", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("entry_index IN (1, 2)", name="ck_provider_token_ledger_entry_index"),
        sa.CheckConstraint(
            "account IN ('purchased', 'available', 'reserved', 'allocated', 'consumed')",
            name="ck_provider_token_ledger_entry_account",
        ),
        sa.CheckConstraint("delta <> 0", name="ck_provider_token_ledger_entry_delta"),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["provider_token_ledger_events.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["inventory_id"], ["provider_token_inventories.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_id", "entry_index", name="uniq_provider_token_ledger_entry_index"),
    )
    op.create_index(
        "ix_provider_token_ledger_entries_inventory",
        "provider_token_ledger_entries",
        ["inventory_id", "created_at"],
        unique=False,
    )

    op.create_table(
        "provider_token_allocation_movements",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("event_id", sa.String(), nullable=False),
        sa.Column("allocation_id", sa.String(), nullable=False),
        sa.Column("movement_index", sa.Integer(), nullable=False),
        sa.Column("available_delta", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("consumed_delta", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("released_delta", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "movement_index > 0",
            name="ck_provider_token_allocation_movement_index",
        ),
        sa.CheckConstraint(
            "available_delta + consumed_delta + released_delta = 0",
            name="ck_provider_token_allocation_movement_conservation",
        ),
        sa.CheckConstraint(
            "available_delta <> 0 OR consumed_delta <> 0 OR released_delta <> 0",
            name="ck_provider_token_allocation_movement_nonzero",
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["provider_token_ledger_events.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["allocation_id"],
            ["provider_token_allocations.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "event_id",
            "movement_index",
            name="uniq_provider_token_allocation_movement_index",
        ),
        sa.UniqueConstraint(
            "event_id",
            "allocation_id",
            name="uniq_provider_token_allocation_movement_allocation",
        ),
    )
    op.create_index(
        "ix_provider_token_allocation_movements_allocation",
        "provider_token_allocation_movements",
        ["allocation_id", "created_at"],
        unique=False,
    )

    op.add_column(
        "token_topups",
        sa.Column("provider_token_reservation_id", sa.String(), nullable=True),
    )
    op.add_column(
        "token_topups",
        sa.Column("provider_token_allocation_id", sa.String(), nullable=True),
    )
    op.create_foreign_key(
        "fk_token_topups_provider_token_reservation",
        "token_topups",
        "provider_token_reservations",
        ["provider_token_reservation_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_token_topups_provider_token_allocation",
        "token_topups",
        "provider_token_allocations",
        ["provider_token_allocation_id"],
        ["id"],
    )
    op.create_index(
        "ix_token_topups_provider_token_reservation_id",
        "token_topups",
        ["provider_token_reservation_id"],
        unique=False,
    )
    op.create_index(
        "ix_token_topups_provider_token_allocation_id",
        "token_topups",
        ["provider_token_allocation_id"],
        unique=False,
    )

    # These audit tables are append-only in PostgreSQL. Corrections must be
    # represented by compensating entries, never UPDATE/DELETE.
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_AUDIT_TRIGGER_FUNCTION}() RETURNS trigger AS $$
            BEGIN
              RAISE EXCEPTION 'provider token audit rows are immutable';
            END;
            $$ LANGUAGE plpgsql
            """
        )
    )
    for table_name in (
        "provider_token_ledger_events",
        "provider_token_ledger_entries",
        "provider_token_allocation_movements",
    ):
        op.execute(
            sa.text(
                f"""
                CREATE TRIGGER trg_{table_name}_immutable
                BEFORE UPDATE OR DELETE ON {table_name}
                FOR EACH ROW EXECUTE FUNCTION {_AUDIT_TRIGGER_FUNCTION}()
                """
            )
        )
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_AUDIT_VALIDATE_FUNCTION}() RETURNS trigger AS $$
            DECLARE
              line_count integer;
              line_balance integer;
              account_count integer;
              min_units integer;
              max_units integer;
              wrong_inventory_count integer;
              movement_count integer;
              movement_available integer;
              movement_consumed integer;
              movement_released integer;
              wrong_movement_scope_count integer;
            BEGIN
              SELECT
                count(*),
                COALESCE(sum(delta), 0),
                count(DISTINCT account),
                COALESCE(min(abs(delta)), 0),
                COALESCE(max(abs(delta)), 0),
                count(*) FILTER (WHERE inventory_id <> NEW.inventory_id)
              INTO
                line_count,
                line_balance,
                account_count,
                min_units,
                max_units,
                wrong_inventory_count
              FROM provider_token_ledger_entries
              WHERE event_id = NEW.id;
              IF line_count <> 2
                 OR line_balance <> 0
                 OR account_count <> 2
                 OR min_units <> NEW.quantity
                 OR max_units <> NEW.quantity
                 OR wrong_inventory_count <> 0 THEN
                RAISE EXCEPTION 'provider token event is not a valid double entry';
              END IF;
              IF NEW.event_type IN (
                'allocation_consumed',
                'allocation_refunded',
                'allocation_released',
                'tenant_allocations_consumed',
                'tenant_consumption_refunded'
              ) THEN
                SELECT
                  count(*),
                  COALESCE(sum(available_delta), 0),
                  COALESCE(sum(consumed_delta), 0),
                  COALESCE(sum(released_delta), 0),
                  count(*) FILTER (
                    WHERE allocation.inventory_id <> NEW.inventory_id
                       OR allocation.tenant_id IS DISTINCT FROM NEW.tenant_id
                       OR (
                         NEW.allocation_id IS NOT NULL
                         AND movement.allocation_id <> NEW.allocation_id
                       )
                  )
                INTO
                  movement_count,
                  movement_available,
                  movement_consumed,
                  movement_released,
                  wrong_movement_scope_count
                FROM provider_token_allocation_movements AS movement
                JOIN provider_token_allocations AS allocation
                  ON allocation.id = movement.allocation_id
                WHERE movement.event_id = NEW.id;
                IF movement_count = 0
                   OR wrong_movement_scope_count <> 0
                   OR (
                     NEW.event_type IN ('allocation_consumed', 'tenant_allocations_consumed')
                     AND (
                       movement_available <> -NEW.quantity
                       OR movement_consumed <> NEW.quantity
                       OR movement_released <> 0
                     )
                   )
                   OR (
                     NEW.event_type IN ('allocation_refunded', 'tenant_consumption_refunded')
                     AND (
                       movement_available <> NEW.quantity
                       OR movement_consumed <> -NEW.quantity
                       OR movement_released <> 0
                     )
                   )
                   OR (
                     NEW.event_type = 'allocation_released'
                     AND (
                       movement_available <> -NEW.quantity
                       OR movement_consumed <> 0
                       OR movement_released <> NEW.quantity
                     )
                   ) THEN
                  RAISE EXCEPTION 'provider token event has invalid allocation movements';
                END IF;
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE CONSTRAINT TRIGGER trg_provider_token_event_balanced
            AFTER INSERT ON provider_token_ledger_events
            DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION {_AUDIT_VALIDATE_FUNCTION}()
            """
        )
    )


def downgrade() -> None:
    op.execute(sa.text("DROP TRIGGER IF EXISTS trg_provider_token_event_balanced ON provider_token_ledger_events"))
    op.execute(sa.text(f"DROP FUNCTION IF EXISTS {_AUDIT_VALIDATE_FUNCTION}()"))

    op.drop_index(
        "ix_token_topups_provider_token_allocation_id",
        table_name="token_topups",
    )
    op.drop_index(
        "ix_token_topups_provider_token_reservation_id",
        table_name="token_topups",
    )
    op.drop_constraint(
        "fk_token_topups_provider_token_allocation",
        "token_topups",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_token_topups_provider_token_reservation",
        "token_topups",
        type_="foreignkey",
    )
    op.drop_column("token_topups", "provider_token_allocation_id")
    op.drop_column("token_topups", "provider_token_reservation_id")

    for table_name in (
        "provider_token_allocation_movements",
        "provider_token_ledger_entries",
        "provider_token_ledger_events",
    ):
        op.execute(sa.text(f"DROP TRIGGER IF EXISTS trg_{table_name}_immutable ON {table_name}"))
    op.execute(sa.text(f"DROP FUNCTION IF EXISTS {_AUDIT_TRIGGER_FUNCTION}()"))

    op.drop_index(
        "ix_provider_token_allocation_movements_allocation",
        table_name="provider_token_allocation_movements",
    )
    op.drop_table("provider_token_allocation_movements")
    op.drop_index("ix_provider_token_ledger_entries_inventory", table_name="provider_token_ledger_entries")
    op.drop_table("provider_token_ledger_entries")
    op.drop_index("ix_provider_token_ledger_events_reversal", table_name="provider_token_ledger_events")
    op.drop_index("ix_provider_token_ledger_events_tenant_created", table_name="provider_token_ledger_events")
    op.drop_index("ix_provider_token_ledger_events_inventory_created", table_name="provider_token_ledger_events")
    op.drop_table("provider_token_ledger_events")
    op.drop_index("ix_provider_token_allocations_tenant", table_name="provider_token_allocations")
    op.drop_table("provider_token_allocations")
    op.drop_index("ix_provider_token_reservations_tenant", table_name="provider_token_reservations")
    op.drop_index("ix_provider_token_reservations_expiry", table_name="provider_token_reservations")
    op.drop_table("provider_token_reservations")
    op.drop_table("provider_token_inventories")

    op.drop_constraint(
        "ck_legal_acceptance_document_sha256_length",
        "legal_acceptances",
        type_="check",
    )
    op.drop_constraint(
        "ck_legal_acceptance_authority_basis",
        "legal_acceptances",
        type_="check",
    )
    op.drop_constraint(
        "ck_legal_acceptance_scope",
        "legal_acceptances",
        type_="check",
    )
    op.drop_constraint(
        "uniq_legal_acceptance_document_hash",
        "legal_acceptances",
        type_="unique",
    )
    op.create_unique_constraint(
        "uniq_legal_acceptance",
        "legal_acceptances",
        ["tenant_id", "user_id", "doc_slug", "doc_version"],
    )
    op.drop_column("legal_acceptances", "document_sha256")
    op.drop_column("legal_acceptances", "authority_basis")
    op.drop_column("legal_acceptances", "accepted_role")
    op.drop_column("legal_acceptances", "acceptance_scope")

    op.drop_constraint(
        "fk_tenants_professional_use_confirmed_by_users",
        "tenants",
        type_="foreignkey",
    )
    op.drop_column("tenants", "stripe_subscription_event_id")
    op.drop_column("tenants", "stripe_subscription_event_created")
    op.drop_column("tenants", "stripe_checkout_period")
    op.drop_column("tenants", "stripe_checkout_plan")
    op.drop_column("tenants", "stripe_checkout_pending_until")
    op.drop_column("tenants", "stripe_checkout_request_key")
    op.drop_column("tenants", "stripe_checkout_session_id")
    op.drop_column("tenants", "professional_use_confirmed_by")
    op.drop_column("tenants", "professional_use_confirmed_at")
