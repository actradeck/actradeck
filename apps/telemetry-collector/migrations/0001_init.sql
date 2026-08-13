CREATE TABLE telemetry_daily (
  installation_hash TEXT NOT NULL CHECK (length(installation_hash) = 64),
  event_name TEXT NOT NULL CHECK (
    event_name IN (
      'install_verified',
      'cockpit_started',
      'cockpit_demo_started',
      'cockpit_demo_completed',
      'first_agent_observed',
      'first_governed_session',
      'governed_session_started',
      'approval_requested',
      'approval_decided',
      'active_day'
    )
  ),
  occurred_on TEXT NOT NULL CHECK (
    length(occurred_on) = 10 AND date(occurred_on) = occurred_on
  ),
  app_version TEXT NOT NULL CHECK (length(app_version) BETWEEN 1 AND 64),
  platform TEXT NOT NULL CHECK (platform IN ('linux', 'darwin', 'win32', 'other')),
  count INTEGER NOT NULL CHECK (count > 0 AND count <= 1000000000),
  first_received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (installation_hash, event_name, occurred_on)
);

CREATE INDEX telemetry_daily_event_day_idx
  ON telemetry_daily (event_name, occurred_on);
