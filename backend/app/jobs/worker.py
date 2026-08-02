import logging

from rq import Connection, Worker

from .queue import get_worker_queue_names, _get_redis_connection
from .webhooks import ensure_webhook_outbox_sweeper


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def run() -> None:
    redis_conn = _get_redis_connection()
    queue_names = get_worker_queue_names()
    try:
        scheduled = ensure_webhook_outbox_sweeper()
        logger.info("Customer webhook outbox sweeper scheduled=%s", scheduled)
    except Exception:
        # The durable rows remain in PostgreSQL. A later worker restart or the
        # manual periodic command can seed the sweep again after Redis recovers.
        logger.exception("Customer webhook outbox sweeper could not be scheduled")
    logger.info("Starting worker for queue=%s", ",".join(queue_names))
    with Connection(redis_conn):
        worker = Worker(queue_names)
        worker.work(with_scheduler=True)


if __name__ == "__main__":
    run()
