"""
Planifie un job de purge retention via RQ.

Execution (depuis backend/):
    python -m scripts.enqueue_retention_purge
    python -m scripts.enqueue_retention_purge --tenant-id <id> --dry-run
"""
import argparse
import json

from app.jobs.queue import enqueue_job
from app.jobs.retention import run_retention_purge


def main() -> None:
    parser = argparse.ArgumentParser(description="Enqueue le job de purge retention.")
    parser.add_argument("--tenant-id", dest="tenant_id", help="Limite la purge a un tenant.")
    parser.add_argument("--dry-run", action="store_true", help="Simule la purge sans suppression.")
    args = parser.parse_args()
    job = enqueue_job(run_retention_purge, tenant_id=args.tenant_id, dry_run=args.dry_run)
    print(json.dumps(job, ensure_ascii=True))


if __name__ == "__main__":
    main()
