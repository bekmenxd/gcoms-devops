# Grafana

## `gamercoms-drift.json`

An operations dashboard built for **the phone first**: every panel is full
width and stacked in one column, so it reads the same on a laptop and in the
Grafana mobile app. Few panels, large numbers.

### Importing

Grafana → Dashboards → New → Import → upload this file. On import it asks for
a Loki data source — pick `grafanacloud-<stack>-logs`. The dashboard uses a
data source *variable* rather than a hardcoded UID precisely so this works
without editing anything.

### On a phone

The official Grafana app (iOS and Android) can browse dashboards and send
push notifications for alerts. Star this dashboard so it is one tap away.

### If panels are empty

The queries were written **without being able to test them against the real
data** — the only Grafana credential in the cluster is the Fluent Bit push
token, which has no read scope. Two assumptions may need correcting, and the
dashboard carries a diagnostics panel at the bottom to tell them apart:

1. **The service label is assumed to be `service_name`**, from the
   `service.name` OTLP resource attribute Fluent Bit sets per input.
2. **`level`, `status`, `route` and `durationMs` are assumed to be structured
   metadata**, i.e. filterable directly as `| level="error"`. If they arrive
   inside the log body instead, every query needs `| json` first:
   `| json | level="error"`.

The bottom panel queries raw lines with no filter at all. If it shows data but
the panels above are empty, it is one of those two. Expand a row there to see
the real field names.

### Suggested alert, not included here

Alerts live outside the dashboard JSON. The one worth having:
`sum(count_over_time({service_name=~".+"} | level="error" [5m])) > 0`,
notifying the mobile app. A dashboard shows a number you have to remember to
look at; an alert tells you when something broke.
