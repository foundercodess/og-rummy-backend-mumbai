# Mobile app — telemetry integration

Optional fields. **Old app versions keep working** without changes.

---

## What works without app changes

| Metric | Source |
|--------|--------|
| Server processing time | `timing.handler_ms` on every socket ACK |
| Request payload size (estimate) | Server measures JSON size of your emit body |
| Response payload size (estimate) | Server measures JSON size of ACK |
| Broadcast payload size | Server measures `game:pick` / `game:turn` emit JSON |

## What requires app changes

| Metric | Required client field |
|--------|------------------------|
| **Client request RTT** (network + server) | `client_sent_at` on emits |
| **Broadcast delivery time** | `client:telemetry:ack` after broadcasts |
| **Exact received size on device** | `received_payload_bytes` on delivery ack |

---

## 1. Every socket emit (pick, discard, join, …)

```dart
final clientSentAt = DateTime.now().toUtc().toIso8601String();
// Also accepted: millisecondsSinceEpoch, or client_rtt_ms computed on device
final traceId = const Uuid().v4(); // or reuse per action

socket.emitWithAck('player:pick', {
  'session_id': sessionId,
  'source': 'closed',
  'client_sent_at': clientSentAt,  // required for Avg Response / p95 in admin
  'trace_id': traceId,
  // Alternative if ISO string is awkward:
  // 'client_rtt_ms': DateTime.now().millisecondsSinceEpoch - sentAtMs,
  // optional: exact bytes if you already serialized the body
  // 'payload_bytes': utf8.encode(jsonEncode(body)).length,
}, (ack) {
  final handlerMs = ack['timing']?['handler_ms'];
  final serverRtt = ack['client_rtt_ms']; // echoed when client_sent_at was sent
});
```

---

## 2. After server broadcasts (`game:pick`, `game:turn`, …)

Listen and confirm delivery:

```dart
socket.on('game:pick', (data) {
  final map = Map<String, dynamic>.from(data as Map);
  final receivedAt = DateTime.now().toUtc().toIso8601String();
  final receivedBytes = utf8.encode(jsonEncode(map)).length;

  socket.emit('client:telemetry:ack', {
    'session_id': map['session_id'],
    'trace_id': map['trace_id'],
    'event_name': 'game:pick',
    'server_emit_at': map['server_time'],
    'client_ack_at': receivedAt,
    'received': true,
    'received_payload_bytes': receivedBytes,
    'render_ms': 12, // optional: UI apply time
  });
});
```

Repeat for `game:turn` and any other broadcast you need to track.

---

## 3. Recommended events to instrument first

| Client emit | Broadcast to ack |
|-------------|------------------|
| `player:pick` | `game:pick` |
| `player:discard` | (next `game:turn` covers turn change) |
| `session:join` | `session:state` (optional) |
| `player:declare` | `game:declare:state` (optional) |

---

## 4. Field reference

### Inbound (app → server)

| Field | Type | Purpose |
|-------|------|---------|
| `trace_id` | string | Correlate emit, ACK, broadcast, delivery ack |
| `client_sent_at` | ISO-8601 UTC | Full request RTT |
| `payload_bytes` | int | Optional; overrides server size estimate |

### Delivery ack (`client:telemetry:ack`)

| Field | Type | Purpose |
|-------|------|---------|
| `trace_id` | string | Same as broadcast `trace_id` |
| `event_name` | string | e.g. `game:pick` |
| `server_emit_at` | ISO-8601 | Copy `server_time` from broadcast |
| `client_ack_at` | ISO-8601 | When app received/handled event |
| `received_payload_bytes` | int | UTF-8 JSON size on device (delivered content size) |
| `render_ms` | int | Optional UI processing time |
| `session_id` | int | Session filter in admin |

### Outbound (server → app) — read only

| Field | Purpose |
|-------|---------|
| `trace_id` | Match to delivery ack |
| `timing.handler_ms` | Server work for your emit |
| `client_rtt_ms` | Echo of RTT when you sent `client_sent_at` |

---

## 5. Admin / support

After integration, support can open:

`GET /api/admin/telemetry/sessions/{sessionId}/report`

Use `report.analytics`:

- `server_processing` — handler time  
- `client_request_rtt` — needs `client_sent_at`  
- `broadcast_delivery` — needs `client:telemetry:ack`  
- `payload_sizes.request` / `payload_sizes.response` — bytes (avg/p95)

Show **N/A** when `sample_count === 0`, not zero.

---

## 6. Rollout checklist

- [ ] Add `client_sent_at` + `trace_id` on pick/discard  
- [ ] Add `client:telemetry:ack` on `game:pick` and `game:turn`  
- [ ] Pass `received_payload_bytes` on delivery ack  
- [ ] Verify admin session report shows `sample_count > 0` for RTT and delivery  
- [ ] Run `npm run migrate` on backend (057 + 058)
