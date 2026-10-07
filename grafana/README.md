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

## `alert-fel-i-produktion.yaml`

The alert that matters more than the dashboard: a dashboard shows a number you
have to remember to look at, an alert tells you when something broke.

Fires when any application service logs an error in the last 5 minutes.
`mongo` is deliberately excluded — mongod writes severity as `s` (I/W/E) with
no `level` field, so Loki guesses and guesses wrong; on 2026-10-06 it reported
~5,000 "errors" from a database that had logged none. Including it would make
the alert fire constantly and be ignored within a day.

**One value to fill in**: replace `DATASOURCE_UID_HERE` with the Loki data
source's uid, visible in the URL at Connections → Data sources → that source.

Then either import it in the Alerting UI, or POST it to
`/api/v1/provisioning/alert-rules` with a service account token (Editor role,
created under Administration → Users and access → Service accounts).

Point it at a contact point under Alerting → Notification policies, and use
the **Test** button there before trusting it — an alert you have never seen
arrive is not yet an alert.

### Original note, superseded by the file above

Alerts live outside the dashboard JSON. The one worth having:
`sum(count_over_time({service_name=~".+"} | level="error" [5m])) > 0`,
notifying the mobile app. A dashboard shows a number you have to remember to
look at; an alert tells you when something broke.
