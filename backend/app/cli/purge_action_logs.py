import argparse
import json
import logging

from app.jobs.periodic import purge_action_logs


logger = logging.getLogger("purge_action_logs")


def main() -> int:
    parser = argparse.ArgumentParser(description="Purge action logs older than N days.")
    parser.add_argument("--days", type=int, default=None, help="Retention in days (override ACTION_LOG_RETENTION_DAYS).")
    parser.add_argument("--dry-run", action="store_true", help="Report deletions without deleting.")
    args = parser.parse_args()

    summary = purge_action_logs(retention_days=args.days, dry_run=args.dry_run)
    print(json.dumps(summary, ensure_ascii=True, separators=(",", ":"), default=str))
    return 0 if summary.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
