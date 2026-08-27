# TokenBench — Phase 1 telemetry env vars.
#
# Preferred: don't source this at all. Launch claude through the launcher,
# which exports these itself AND starts the collector if needed:
#
#   ./tb-claude          # or: bin/tokenbench claude
#
# This file remains for manual setups. Source it in the shell you launch
# Claude Code from:
#
#   source env.sh && claude
#
# These are per-shell. A Claude Code session started from a shell that did not
# source this file emits nothing — the launcher exists specifically to remove
# that failure mode. Diagnose with:  node collector.js --check

# --- from the PRD, section 4.1 ---
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_LOGS_EXPORT_INTERVAL=1000

# --- addition ---
# The PRD lists claude_code.session.count as an event, but Claude Code emits it
# on the metrics pipeline, not the logs pipeline. Without these two it never
# arrives. The collector handles /v1/metrics as well as /v1/logs.
export OTEL_METRICS_EXPORTER=otlp
export OTEL_METRIC_EXPORT_INTERVAL=1000

# Off by default, and left off: this would send prompt text to the collector.
# Phase 1 needs token counts, not content.
# export OTEL_LOG_USER_PROMPTS=1

# --- PII, second layer of defence (PRD v1.1 4.1 note 4) ---
# This trims one identity field from the METRICS pipeline only. Log events still
# carry all five (user.email, user.id, user.account_uuid, user.account_id,
# organization.id), so this is a belt-and-braces measure, not the protection.
# The real protection is the ingest allowlist in src/store.js.
export OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false
