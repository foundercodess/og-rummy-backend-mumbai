# Admin Telemetry UI — Integration Guide (for AI / frontend agent)

Use this document to build the **Admin Telemetry** screens and wire them to the backend APIs. All endpoints require **admin auth** (same as existing admin panel: `Authorization: Bearer <admin_jwt>`).

---

## Goal

Operators need to:

1. See **latency** (server handler time + optional client RTT) per socket action.
2. See **errors** (`success: false` ACKs and error messages).
3. See whether a **broadcast reached the client** (compare `socket_emit` vs `client:telemetry:ack` by `trace_id`).
4. Build **session reports** for support / client bug tickets.

---

## Environment (backend)

| Variable | Default | Description |
|----------|---------|-------------|
| `GAME_TELEMETRY_ENABLED` | `true` | Set `false` to disable DB writes (no breaking change to game). |

Run migrations before use:

```bash
npm run migrate
```

Creates `game_telemetry_events` (056), `delivery_ms` (057), `request_bytes` / `response_bytes` (058).

---

## Admin API base

Assume base URL: `{API_BASE}/api/admin` (mounted in `server.js` as `app.use('/api/admin', adminRoutes)`).

### 1. Global summary dashboard

`GET /admin/telemetry/summary`

**Query (optional):**

| Param | Description |
|-------|-------------|
| `from` | ISO date — filter `created_at >= from` |
| `to` | ISO date — filter `created_at <= to` |
| `top_events` | Max rows in `by_event` (default 25, max 100) |

**Response:**

```json
{
  "success": true,
  "message": "Telemetry summary loaded",
  "summary": {
    "avg_response_ms": 95,
    "p95_response_ms": 210,
    "analytics": {
      "server_processing": { "sample_count": 500, "avg_ms": 42, "p95_ms": 180 },
      "client_request_rtt": { "sample_count": 1800, "avg_ms": 95, "p95_ms": 210 },
      "broadcast_delivery": { "sample_count": 1200, "avg_ms": 48, "p95_ms": 120 }
    },
    "latency_cards": {
      "avg_response": { "avg_ms": 95, "p95_ms": 210, "sample_count": 1800 }
    },
    "totals": {
      "total_events": 12040,
      "sessions": 88,
      "users": 120,
      "errors": 34,
      "emits": 4100,
      "client_acks": 3900,
      "avg_handler_ms": 42,
      "p95_handler_ms": 180,
      "avg_client_request_rtt_ms": 95,
      "p95_client_request_rtt_ms": 210,
      "avg_broadcast_delivery_ms": 48,
      "p95_broadcast_delivery_ms": 120,
      "avg_response_ms": 95,
      "p95_response_ms": 210,
      "client_request_rtt_samples": 1800,
      "broadcast_delivery_samples": 1200
    },
    "by_event": [
      {
        "event_name": "player:pick",
        "event_count": 2200,
        "error_count": 12,
        "avg_handler_ms": 55,
        "p95_handler_ms": 210,
        "avg_client_request_rtt_ms": 88,
        "p95_client_request_rtt_ms": 195,
        "avg_response_ms": 88,
        "p95_response_ms": 195
      }
    ],
    "data_quality": {
      "response_metrics_available": true,
      "broadcast_metrics_available": true,
      "client_request_rtt_samples": 1800,
      "broadcast_delivery_samples": 1200
    },
    "recent_errors": [ /* telemetry event rows */ ],
    "filters": { "fromDate": null, "toDate": null, "limit": 25 }
  }
}
```

**UI:** Cards for totals; table sorted by `event_count`; red list for `recent_errors`.

**Dashboard cards (Avg Response / Slowest p95)** — use **any one** of these paths (same values):

| UI label | Preferred path |
|----------|----------------|
| Avg Response | `summary.analytics.client_request_rtt.avg_ms` or `summary.avg_response_ms` or `summary.latency_cards.avg_response.avg_ms` |
| Slowest (p95) | `summary.analytics.client_request_rtt.p95_ms` or `summary.p95_response_ms` or `summary.latency_cards.avg_response.p95_ms` |

**Do not** read from `by_event[0]` — the first row is often `game:turn` / `socket_emit` where RTT is always null.

**Do not** use `totals.avg_handler_ms` for client response — that alias is **server processing** only.

Show **N/A** when `summary.data_quality.client_request_rtt_samples === 0` (not when `by_event` rows are null).

---

### 2. Paginated event log

`GET /admin/telemetry/events`

**Query:**

| Param | Description |
|-------|-------------|
| `page` | Default `1` |
| `limit` | Default `50`, max `500` |
| `session_id` | Filter by game session |
| `user_id` | Filter by user |
| `event_name` | e.g. `player:pick` |
| `success` | `true` or `false` |
| `trace_id` | Exact trace |
| `from`, `to` | Date range |

**Response:**

```json
{
  "success": true,
  "message": "Telemetry events loaded",
  "events": [
    {
      "id": 1,
      "game_session_id": 558,
      "user_id": 3,
      "socket_id": "abc",
      "trace_id": "a1b2c3...",
      "direction": "inbound",
      "channel": "socket_ack",
      "event_name": "player:pick",
      "success": true,
      "error_message": null,
      "delivery_status": null,
      "client_sent_at": "2026-05-15T09:22:14.100Z",
      "server_received_at": "...",
      "server_completed_at": "...",
      "client_ack_at": null,
      "handler_ms": 85,
      "client_rtt_ms": 120,
      "payload_summary": { "session_id": 558, "source": "closed" },
      "ack_summary": { "success": true, "valid_for_declare": false },
      "created_at": "..."
    }
  ],
  "pagination": {
    "total": 400,
    "limit": 50,
    "offset": 0,
    "total_pages": 8,
    "page": 1
  }
}
```

**UI:** Filter bar + sortable table; row click → trace detail.

---

### 3. Session report (primary support view)

`GET /admin/telemetry/sessions/:sessionId/report`

**Query:** optional `from`, `to`

**Response includes `report.analytics`** — use this for dashboards (not raw zeros).

```json
{
  "success": true,
  "report": {
    "session_id": 558,
    "analytics": {
      "server_processing": {
        "sample_count": 24,
        "avg_ms": 72,
        "p95_ms": 190,
        "min_ms": 12,
        "max_ms": 310
      },
      "client_request_rtt": {
        "sample_count": 0,
        "avg_ms": null,
        "p95_ms": null
      },
      "broadcast_delivery": {
        "sample_count": 18,
        "avg_ms": 45,
        "p95_ms": 120
      },
      "data_quality": {
        "client_request_rtt_available": false,
        "client_request_rtt_note": "No client_sent_at samples yet — update the mobile app.",
        "broadcast_delivery_available": true,
        "broadcast_delivery_note": "Computed from socket_emit -> client:telemetry:ack.",
        "server_processing_note": "handler_ms on inbound socket ACKs (server work only)."
      }
    },
    "summary": [ /* per event_name + channel; see metric names below */ ],
    "timeline": [],
    "errors": [],
    "undelivered_emits": []
  }
}
```

#### Metric definitions (do not confuse)

| Metric | Source | When `null` / zero in UI |
|--------|--------|-------------------------|
| **server_processing** (`handler_ms` on `socket_ack`) | Server handler time | Always available after actions; use `timing.handler_ms` on ACK |
| **client_request_rtt** (`client_rtt_ms` on `socket_ack`) | `client_sent_at` → server receive | **null until app sends `client_sent_at`** — not the same as handler_ms |
| **broadcast_delivery** (`delivery_ms` on `client_ack`) | `game:pick`/`game:turn` emit → `client:telemetry:ack` | **null until app sends delivery ack** |

**Do not** show `0` when `sample_count === 0` — show **“N/A”** and `data_quality` notes.

**UI:**

- Link from **Game History Detail** as tab **Telemetry**.
- Three cards: Server processing | Client request RTT | Broadcast delivery.
- Timeline: plot `server_handler_ms`, `client_rtt_ms`, `delivery_ms` per row (skip nulls).
- Highlight `errors` and `undelivered_emits` in red.

---

### 4. Trace detail (single action drill-down)

`GET /admin/telemetry/traces/:traceId`

**Response:**

```json
{
  "success": true,
  "message": "Telemetry trace loaded",
  "trace_id": "abc123",
  "events": [
    { "channel": "socket_ack", "event_name": "player:pick", "handler_ms": 85, ... },
    { "channel": "socket_emit", "event_name": "game:pick", "delivery_status": "sent", ... },
    { "channel": "client_ack", "event_name": "game:pick", "delivery_status": "acked_by_client", ... }
  ]
}
```

**UI:** Vertical stepper: Client emit → Server ACK → Broadcast → Client received.

---

## Mobile client integration (for delivery + RTT)

**Full mobile guide:** [MOBILE_APP_TELEMETRY.md](./MOBILE_APP_TELEMETRY.md)

Optional but recommended. **No breaking change** — old apps keep working.

### On every socket emit (e.g. `player:pick`)

```json
{
  "session_id": 558,
  "source": "closed",
  "trace_id": "<uuid-or-hex>",
  "client_sent_at": "2026-05-15T09:22:14.100Z"
}
```

### On every socket ACK handler

Read optional fields (ignore if missing):

```json
{
  "success": true,
  "trace_id": "...",
  "server_time": "...",
  "timing": { "handler_ms": 85 },
  "data": { ... }
}
```

Compute: `rtt_ms = Date.now() - parse(client_sent_at)`.

### After handling server **broadcast** (`game:pick`, `game:turn`, …)

Payload includes `trace_id` and `server_time`. Confirm delivery (required for **broadcast_delivery** analytics):

```javascript
socket.on('game:pick', (payload) => {
  const receivedAt = new Date().toISOString();
  socket.emit('client:telemetry:ack', {
    session_id: payload.session_id,
    trace_id: payload.trace_id,
    event_name: 'game:pick',
    server_time: payload.server_time,
    server_emit_at: payload.server_time,
    client_ack_at: receivedAt,
    received: true,
    render_ms: 12
  });
});
```

---

## `channel` / `direction` reference

| channel | direction | Meaning |
|---------|-----------|---------|
| `socket_ack` | inbound | Client called a socket event; server finished handler |
| `socket_emit` | outbound | Server broadcast to session room |
| `client_ack` | inbound | Client confirmed it received/handled a broadcast |

---

## Suggested admin pages

1. **Telemetry Overview** — `GET /telemetry/summary`
2. **Event Explorer** — `GET /telemetry/events` with filters
3. **Session Telemetry** — `GET /telemetry/sessions/:id/report` (from game history)
4. **Trace Viewer** — `GET /telemetry/traces/:traceId`

---

## Error codes (HTTP)

| code | HTTP | Message |
|------|------|---------|
| `INVALID_SESSION_ID` | 400 | Bad session id |
| `INVALID_USER_ID` | 400 | Bad user id |
| `INVALID_DATE_FROM` / `INVALID_DATE_TO` | 400 | Bad date |
| `TRACE_NOT_FOUND` | 404 | Unknown trace |

---

## Game logic / contract safety

- Existing socket event names and payload shapes are **unchanged**.
- New optional fields: `trace_id`, `timing.handler_ms` on ACKs; `trace_id` on some broadcasts.
- Game rules (declare, scoring, turns) are **not** modified by telemetry.
- Disable telemetry with `GAME_TELEMETRY_ENABLED=false` if needed.

---

## QA checklist

- [ ] Migration applied; table exists
- [ ] Play one turn: `player:pick` appears in `/telemetry/events`
- [ ] Failed pick (wrong turn) shows `success: false`
- [ ] Session report loads for that `session_id`
- [ ] With mobile `client:telemetry:ack`, `undelivered_emits` shrinks
- [ ] `GAME_TELEMETRY_ENABLED=false` — game still works, no new rows

---

## Related existing APIs

| API | Use |
|-----|-----|
| `GET /admin/games/history/:sessionId` | Game milestones (`game_session_events`) — business events |
| `GET /admin/telemetry/sessions/:id/report` | Technical latency/delivery — this system |

Show both tabs on session detail: **Events** vs **Telemetry**.
