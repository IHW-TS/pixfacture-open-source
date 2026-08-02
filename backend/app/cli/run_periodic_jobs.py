import argparse
import json
import logging
import sys
import time

from app.jobs.retention import (
    expire_ended_trials,
    purge_stale_demo_invitations,
    run_retention_purge,
    run_trial_lifecycle_cleanup,
)
from app.jobs.trial_lifecycle_notifications import run_trial_lifecycle_notifications
from app.jobs.periodic import purge_action_logs, purge_pdp_account_raw_json, run_sync_pending_transmissions, run_directory_refresh_once
from app.jobs.inbox import run_poll_inbox
from app.jobs.ereporting import run_generate_ereporting_reports, run_process_due_ereporting, run_process_due_ereporting_reports
from app.jobs.seqino_usage import sync_seqino_usage
from app.jobs.seqino_token_inventory import run_seqino_token_inventory_monitor_once
from app.jobs.quote_followups import run_quote_followups_once
from app.jobs.invoice_followups import run_invoice_followups_once
from app.jobs.webhooks import enqueue_due_webhook_deliveries, purge_webhook_outbox
from app.config import settings
from app.jobs.heartbeat import expected_heartbeat_ttl_seconds, set_periodic_heartbeat


logger = logging.getLogger("periodic_jobs")
RETENTION_INTERVAL_SECONDS = 24 * 60 * 60
MIN_LOOP_INTERVAL_SECONDS = 60


def _normalize_interval(value: int | None, default: int, label: str) -> int:
    interval = default if value is None else int(value)
    if interval < MIN_LOOP_INTERVAL_SECONDS:
        logger.warning(
            json.dumps(
                {
                    "event": "periodic_jobs_interval_adjusted",
                    "label": label,
                    "requested": interval,
                    "applied": MIN_LOOP_INTERVAL_SECONDS,
                }
            )
        )
        interval = MIN_LOOP_INTERVAL_SECONDS
    return interval


def run_retention_once(dry_run: bool = False, retention_tenant_id: str | None = None) -> int:
    logger.info(json.dumps({"event": "retention_jobs_start", "dry_run": dry_run}))
    lifecycle_failed = False
    try:
        trial_summary = expire_ended_trials(dry_run=dry_run)
        logger.info(json.dumps({"event": "trial_expiration_done", "summary": trial_summary}))
    except Exception:
        logger.exception("trial_expiration_failed")
        return 1
    try:
        notification_summary = run_trial_lifecycle_notifications(
            dry_run=dry_run,
            tenant_id=retention_tenant_id,
        )
        logger.info(
            json.dumps(
                {
                    "event": "trial_lifecycle_notifications_done",
                    "summary": notification_summary,
                }
            )
        )
        if not notification_summary.get("ok"):
            lifecycle_failed = True
    except Exception:
        logger.exception("trial_lifecycle_notifications_failed")
        lifecycle_failed = True
    try:
        lifecycle_summary = run_trial_lifecycle_cleanup(
            dry_run=dry_run,
            tenant_id=retention_tenant_id,
        )
        logger.info(json.dumps({"event": "trial_lifecycle_cleanup_done", "summary": lifecycle_summary}))
        if not lifecycle_summary.get("ok"):
            lifecycle_failed = True
    except Exception:
        logger.exception("trial_lifecycle_cleanup_failed")
        lifecycle_failed = True
    try:
        invitation_summary = purge_stale_demo_invitations(dry_run=dry_run)
        logger.info(
            json.dumps(
                {
                    "event": "demo_invitation_retention_done",
                    "summary": invitation_summary,
                }
            )
        )
        if not invitation_summary.get("ok"):
            lifecycle_failed = True
    except Exception:
        logger.exception("demo_invitation_retention_failed")
        lifecycle_failed = True
    try:
        retention_summary = run_retention_purge(tenant_id=retention_tenant_id, dry_run=dry_run)
        logger.info(json.dumps({"event": "retention_purge_done", "summary": retention_summary}))
    except Exception:
        logger.exception("retention_purge_failed")
        return 1

    try:
        purge_action_logs(dry_run=dry_run)
    except Exception:
        logger.exception("action_log_purge_failed")
        return 1
    try:
        purge_pdp_account_raw_json(dry_run=dry_run)
    except Exception:
        logger.exception("pdp_raw_json_purge_failed")
        return 1
    try:
        purge_webhook_outbox(dry_run=dry_run)
    except Exception:
        logger.exception("webhook_outbox_purge_failed")
        return 1
    if lifecycle_failed:
        logger.error(json.dumps({"event": "retention_jobs_failed", "phase": "trial_lifecycle_cleanup"}))
        return 1
    logger.info(json.dumps({"event": "retention_jobs_done", "dry_run": dry_run}))
    set_periodic_heartbeat("retention")
    return 0


def run_einvoicing_sync_once() -> int:
    logger.info(json.dumps({"event": "einvoicing_sync_start"}))
    try:
        sync_summary = run_sync_pending_transmissions()
        logger.info(json.dumps({"event": "einvoicing_sync_done", "summary": sync_summary}))
    except Exception:
        logger.exception("einvoicing_sync_failed")
        return 1
    set_periodic_heartbeat("einvoicing_sync")
    return 0


def run_inbox_poll_once() -> int:
    logger.info(json.dumps({"event": "inbox_poll_start"}))
    try:
        summary = run_poll_inbox()
        logger.info(json.dumps({"event": "inbox_poll_done", "summary": summary}))
    except Exception:
        logger.exception("inbox_poll_failed")
        return 1
    set_periodic_heartbeat("inbox_poll")
    return 0


def run_ereporting_retry_once() -> int:
    logger.info(json.dumps({"event": "ereporting_retry_start"}))
    try:
        summary = run_process_due_ereporting()
        logger.info(json.dumps({"event": "ereporting_retry_done", "summary": summary}))
    except Exception:
        logger.exception("ereporting_retry_failed")
        return 1
    set_periodic_heartbeat("ereporting_retry")
    return 0


def run_ereporting_report_retry_once() -> int:
    logger.info(json.dumps({"event": "ereporting_report_retry_start"}))
    try:
        summary = run_process_due_ereporting_reports()
        logger.info(json.dumps({"event": "ereporting_report_retry_done", "summary": summary}))
    except Exception:
        logger.exception("ereporting_report_retry_failed")
        return 1
    set_periodic_heartbeat("ereporting_report_retry")
    return 0


def run_ereporting_generate_once() -> int:
    logger.info(json.dumps({"event": "ereporting_generate_start"}))
    try:
        summary = run_generate_ereporting_reports()
        logger.info(json.dumps({"event": "ereporting_generate_done", "summary": summary}))
    except Exception:
        logger.exception("ereporting_generate_failed")
        return 1
    set_periodic_heartbeat("ereporting_generate")
    return 0


def run_seqino_usage_once(period: str | None = None) -> int:
    logger.info(json.dumps({"event": "seqino_usage_start", "period": period}))
    try:
        summary = sync_seqino_usage(period=period)
        logger.info(json.dumps({"event": "seqino_usage_done", "summary": summary}))
    except Exception:
        logger.exception("seqino_usage_failed")
        return 1
    if summary.get("ok"):
        set_periodic_heartbeat("seqino_usage")
        return 0
    return 1


def run_seqino_token_inventory_once() -> int:
    logger.info(json.dumps({"event": "seqino_token_inventory_start"}))
    try:
        summary = run_seqino_token_inventory_monitor_once()
    except Exception:
        logger.exception("seqino_token_inventory_failed")
        return 1
    if not summary.get("ok"):
        return 1
    set_periodic_heartbeat("seqino_token_inventory")
    return 0


def run_webhook_outbox_once() -> int:
    logger.info(json.dumps({"event": "webhook_outbox_start"}))
    try:
        summary = enqueue_due_webhook_deliveries()
    except Exception:
        logger.exception("webhook_outbox_failed")
        return 1
    if not summary.get("ok"):
        return 1
    set_periodic_heartbeat("webhook_outbox")
    return 0


def run_all(dry_run: bool = False, retention_tenant_id: str | None = None) -> int:
    logger.info(json.dumps({"event": "periodic_jobs_start", "dry_run": dry_run}))
    if run_retention_once(dry_run=dry_run, retention_tenant_id=retention_tenant_id) != 0:
        return 1
    if run_seqino_token_inventory_once() != 0:
        return 1
    if run_webhook_outbox_once() != 0:
        return 1
    if run_einvoicing_sync_once() != 0:
        return 1
    if run_inbox_poll_once() != 0:
        return 1
    if run_ereporting_generate_once() != 0:
        return 1
    if run_ereporting_report_retry_once() != 0:
        return 1
    if run_ereporting_retry_once() != 0:
        return 1
    logger.info(json.dumps({"event": "periodic_jobs_done", "dry_run": dry_run}))
    return 0


def _run_loop(mode: str, interval_seconds: int, dry_run: bool, retention_tenant_id: str | None) -> int:
    logger.info(
        json.dumps(
            {
                "event": "periodic_jobs_loop_start",
                "mode": mode,
                "interval_seconds": interval_seconds,
                "dry_run": dry_run,
            }
        )
    )
    while True:
        if mode == "retention":
            exit_code = run_retention_once(dry_run=dry_run, retention_tenant_id=retention_tenant_id)
        elif mode == "einvoicing_sync":
            exit_code = run_einvoicing_sync_once()
        elif mode == "directory_refresh":
            summary = run_directory_refresh_once()
            exit_code = 0 if summary.get("ok") else 1
        elif mode == "ereporting_report_retry":
            exit_code = run_ereporting_report_retry_once()
        elif mode == "ereporting_generate":
            exit_code = run_ereporting_generate_once()
        elif mode == "seqino_usage":
            exit_code = run_seqino_usage_once()
        elif mode == "seqino_token_inventory":
            exit_code = run_seqino_token_inventory_once()
        elif mode == "ereporting_retry":
            exit_code = run_ereporting_retry_once()
        elif mode == "quote_followups":
            summary = run_quote_followups_once()
            exit_code = 0 if summary.get("ok") else 1
        elif mode == "invoice_followups":
            summary = run_invoice_followups_once()
            exit_code = 0 if summary.get("ok") else 1
        elif mode == "webhook_outbox":
            exit_code = run_webhook_outbox_once()
        else:
            exit_code = run_inbox_poll_once()
        if exit_code != 0:
            return exit_code
        set_periodic_heartbeat(
            mode,
            ttl_seconds=expected_heartbeat_ttl_seconds(mode, interval_seconds),
            interval_seconds=interval_seconds,
        )
        time.sleep(interval_seconds)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run periodic maintenance jobs")
    parser.add_argument(
        "--mode",
        choices=[
            "all",
            "retention",
            "einvoicing_sync",
            "inbox_poll",
            "ereporting_retry",
            "ereporting_report_retry",
            "ereporting_generate",
            "directory_refresh",
            "seqino_usage",
            "seqino_token_inventory",
            "quote_followups",
            "invoice_followups",
            "webhook_outbox",
        ],
        default="all",
        help="Job mode to run",
    )
    parser.add_argument("--dry-run", action="store_true", help="Do not delete data")
    parser.add_argument("--tenant-id", default=None, help="Limit retention purge to a tenant")
    parser.add_argument("--period", default=None, help="Period (YYYY-MM) for seqino_usage")
    parser.add_argument("--loop", action="store_true", help="Run in a loop with sleep intervals")
    parser.add_argument("--interval-seconds", type=int, default=None, help="Override loop interval in seconds")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format='{"ts":"%(asctime)s","lvl":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
    )
    if args.mode == "retention":
        if args.loop:
            interval = _normalize_interval(args.interval_seconds, RETENTION_INTERVAL_SECONDS, "retention")
            return _run_loop("retention", interval, args.dry_run, args.tenant_id)
        return run_retention_once(dry_run=args.dry_run, retention_tenant_id=args.tenant_id)
    if args.mode == "einvoicing_sync":
        if args.loop:
            interval = _normalize_interval(
                args.interval_seconds,
                getattr(settings, "EINVOICING_SYNC_INTERVAL_SECONDS", 300),
                "einvoicing_sync",
            )
            return _run_loop("einvoicing_sync", interval, args.dry_run, args.tenant_id)
        return run_einvoicing_sync_once()
    if args.mode == "inbox_poll":
        if args.loop:
            interval = _normalize_interval(
                args.interval_seconds,
                getattr(settings, "INBOX_POLL_INTERVAL_SECONDS", 300),
                "inbox_poll",
            )
            return _run_loop("inbox_poll", interval, args.dry_run, args.tenant_id)
        return run_inbox_poll_once()
    if args.mode == "ereporting_retry":
        if args.loop:
            interval = _normalize_interval(
                args.interval_seconds,
                getattr(settings, "EREPORTING_RETRY_INTERVAL_SECONDS", 300),
                "ereporting_retry",
            )
            return _run_loop("ereporting_retry", interval, args.dry_run, args.tenant_id)
        return run_ereporting_retry_once()
    if args.mode == "ereporting_report_retry":
        if args.loop:
            interval = _normalize_interval(
                args.interval_seconds,
                getattr(settings, "EREPORTING_RETRY_INTERVAL_SECONDS", 300),
                "ereporting_report_retry",
            )
            return _run_loop("ereporting_report_retry", interval, args.dry_run, args.tenant_id)
        return run_ereporting_report_retry_once()
    if args.mode == "ereporting_generate":
        if args.loop:
            interval = _normalize_interval(
                args.interval_seconds,
                getattr(settings, "EREPORTING_GENERATE_INTERVAL_SECONDS", 86400),
                "ereporting_generate",
            )
            return _run_loop("ereporting_generate", interval, args.dry_run, args.tenant_id)
        return run_ereporting_generate_once()
    if args.mode == "directory_refresh":
        if args.loop:
            interval = _normalize_interval(
                args.interval_seconds,
                getattr(settings, "DIRECTORY_SYNC_INTERVAL_SECONDS", 86400),
                "directory_refresh",
            )
            return _run_loop("directory_refresh", interval, args.dry_run, args.tenant_id)
        run_directory_refresh_once()
        return 0
    if args.mode == "seqino_usage":
        if args.loop:
            interval = _normalize_interval(
                args.interval_seconds,
                getattr(settings, "SEQINO_USAGE_INTERVAL_SECONDS", 2592000),
                "seqino_usage",
            )
            return _run_loop("seqino_usage", interval, args.dry_run, args.tenant_id)
        return run_seqino_usage_once(period=args.period)
    if args.mode == "seqino_token_inventory":
        if args.loop:
            interval = _normalize_interval(
                args.interval_seconds,
                getattr(settings, "SEQINO_TOKEN_INVENTORY_INTERVAL_SECONDS", 300),
                "seqino_token_inventory",
            )
            return _run_loop(
                "seqino_token_inventory",
                interval,
                args.dry_run,
                args.tenant_id,
            )
        return run_seqino_token_inventory_once()
    if args.mode == "quote_followups":
        if args.loop:
            interval = _normalize_interval(
                args.interval_seconds,
                getattr(settings, "QUOTE_FOLLOWUP_INTERVAL_SECONDS", 3600),
                "quote_followups",
            )
            return _run_loop("quote_followups", interval, args.dry_run, args.tenant_id)
        res = run_quote_followups_once()
        return 0 if res.get("ok") else 1
    if args.mode == "invoice_followups":
        if args.loop:
            interval = _normalize_interval(
                args.interval_seconds,
                getattr(settings, "INVOICE_FOLLOWUP_INTERVAL_SECONDS", 3600),
                "invoice_followups",
            )
            return _run_loop("invoice_followups", interval, args.dry_run, args.tenant_id)
        res = run_invoice_followups_once()
        return 0 if res.get("ok") else 1
    if args.mode == "webhook_outbox":
        if args.loop:
            interval = _normalize_interval(
                args.interval_seconds,
                getattr(settings, "WEBHOOK_OUTBOX_SWEEP_INTERVAL_SECONDS", 30),
                "webhook_outbox",
            )
            return _run_loop("webhook_outbox", interval, args.dry_run, args.tenant_id)
        return run_webhook_outbox_once()
    return run_all(dry_run=args.dry_run, retention_tenant_id=args.tenant_id)


if __name__ == "__main__":
    sys.exit(main())
