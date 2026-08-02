#!/bin/sh
set -e
msg=${1:-"new migration"}
alembic revision -m "$msg"
