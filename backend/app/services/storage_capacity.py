from __future__ import annotations

from dataclasses import asdict, dataclass


BYTES_PER_MIB = 1024 * 1024
BYTES_PER_GIB = 1024 * BYTES_PER_MIB


@dataclass(frozen=True)
class CapacityScenario:
    tenants: int
    years: int = 10
    invoices_per_tenant_month: int = 20
    purchases_per_tenant_month: int = 30
    quotes_per_tenant_month: int = 20
    invoice_pdf_kib: int = 350
    facturx_pdf_kib: int = 450
    invoice_xml_kib: int = 50
    purchase_attachment_kib: int = 600
    quote_attachment_kib: int = 0
    attachment_quota_mb_per_tenant: int = 200
    object_storage_cost_per_gib_month_eur: float = 0.014
    vps_disk_gib: int = 80
    max_sync_export_records: int = 5_000


def _mib(value: int | float) -> float:
    return round(float(value) / BYTES_PER_MIB, 2)


def _gib(value: int | float) -> float:
    return round(float(value) / BYTES_PER_GIB, 3)


def _assessment_for_tenants(tenants: int) -> str:
    if tenants <= 50:
        return "ok_8gb_s3_monitored"
    if tenants <= 200:
        return "watch_8_16gb_workers_db_pool"
    return "split_services_external_db_workers"


def _sync_export_mode(estimated_records_per_tenant: int, max_sync_export_records: int) -> str:
    if max_sync_export_records <= 0:
        return "unbounded_not_recommended"
    if estimated_records_per_tenant > max_sync_export_records:
        return "async_required"
    if estimated_records_per_tenant > int(max_sync_export_records * 0.7):
        return "near_limit"
    return "sync_ok"


def project_storage_capacity(scenario: CapacityScenario) -> dict[str, object]:
    tenants = max(int(scenario.tenants), 0)
    months = max(int(scenario.years), 0) * 12
    invoice_count = tenants * max(scenario.invoices_per_tenant_month, 0) * months
    purchase_count = tenants * max(scenario.purchases_per_tenant_month, 0) * months
    quote_count = tenants * max(scenario.quotes_per_tenant_month, 0) * months

    invoice_artifact_bytes_each = (
        max(scenario.invoice_pdf_kib, 0) + max(scenario.facturx_pdf_kib, 0) + max(scenario.invoice_xml_kib, 0)
    ) * 1024
    invoice_artifacts_bytes = invoice_count * invoice_artifact_bytes_each
    purchase_attachments_bytes = purchase_count * max(scenario.purchase_attachment_kib, 0) * 1024
    quote_attachments_bytes = quote_count * max(scenario.quote_attachment_kib, 0) * 1024
    attachment_quota_worst_case_bytes = tenants * max(scenario.attachment_quota_mb_per_tenant, 0) * BYTES_PER_MIB
    estimated_object_storage_bytes = invoice_artifacts_bytes + purchase_attachments_bytes + quote_attachments_bytes
    storage_with_full_quota_bytes = max(estimated_object_storage_bytes, attachment_quota_worst_case_bytes)

    estimated_records_per_tenant = (
        max(scenario.invoices_per_tenant_month, 0) * months * 4
        + max(scenario.purchases_per_tenant_month, 0) * months * 4
        + max(scenario.quotes_per_tenant_month, 0) * months * 3
        + 50
    )
    object_storage_gib = estimated_object_storage_bytes / BYTES_PER_GIB
    monthly_cost = object_storage_gib * max(float(scenario.object_storage_cost_per_gib_month_eur), 0.0)
    vps_disk_pressure_percent = (
        (estimated_object_storage_bytes / (max(scenario.vps_disk_gib, 1) * BYTES_PER_GIB)) * 100
        if scenario.vps_disk_gib
        else 0.0
    )

    return {
        "scenario": asdict(scenario),
        "counts": {
            "tenants": tenants,
            "months": months,
            "invoices": invoice_count,
            "purchases": purchase_count,
            "quotes": quote_count,
            "estimated_records_per_tenant_export": estimated_records_per_tenant,
        },
        "bytes": {
            "invoice_artifacts": invoice_artifacts_bytes,
            "purchase_attachments": purchase_attachments_bytes,
            "quote_attachments": quote_attachments_bytes,
            "estimated_object_storage": estimated_object_storage_bytes,
            "attachment_quota_worst_case": attachment_quota_worst_case_bytes,
            "storage_with_full_quota": storage_with_full_quota_bytes,
        },
        "human": {
            "invoice_artifacts_gib": _gib(invoice_artifacts_bytes),
            "purchase_attachments_gib": _gib(purchase_attachments_bytes),
            "estimated_object_storage_gib": _gib(estimated_object_storage_bytes),
            "attachment_quota_worst_case_gib": _gib(attachment_quota_worst_case_bytes),
            "storage_with_full_quota_gib": _gib(storage_with_full_quota_bytes),
            "estimated_object_storage_mib": _mib(estimated_object_storage_bytes),
        },
        "costs": {
            "object_storage_cost_per_gib_month_eur": scenario.object_storage_cost_per_gib_month_eur,
            "estimated_monthly_storage_eur": round(monthly_cost, 2),
            "estimated_yearly_storage_eur": round(monthly_cost * 12, 2),
        },
        "ops": {
            "vps_assessment": _assessment_for_tenants(tenants),
            "vps_disk_gib": scenario.vps_disk_gib,
            "vps_disk_pressure_percent_if_local": round(vps_disk_pressure_percent, 1),
            "sync_export_mode": _sync_export_mode(estimated_records_per_tenant, scenario.max_sync_export_records),
            "requires_object_storage": True,
            "requires_async_exports": estimated_records_per_tenant > scenario.max_sync_export_records,
        },
    }


def project_many(base: CapacityScenario, tenant_counts: list[int]) -> list[dict[str, object]]:
    return [project_storage_capacity(CapacityScenario(**{**asdict(base), "tenants": tenants})) for tenants in tenant_counts]
