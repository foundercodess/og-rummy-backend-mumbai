# 🎰 Socket Testing UI Guide

A comprehensive HTML-based testing interface for your Rummy socket implementation is now available at:

```
http://localhost:3000/test.html
```

## Features

### 1️⃣ **Authentication Tab**
- Send OTP to any 10-digit phone number
- Verify OTP (default: `1111` for testing)
- View JWT token details
- Copy token for manual API calls

**Test Flow:**
```
Phone: 9999999999 → Send OTP → OTP: 1111 → Verify OTP
```

### 2️⃣ **Session Tab**
- Create game sessions with configurable parameters
- Set game ID, contest ID, and max players
- View session details (ID, code, status)
- Copy session ID for joining from other clients

**Parameters:**
- Game ID: 1 (must exist in DB)
- Contest ID: 1 (must exist in DB)
- Max Players: 2-6 (default 4)

### 3️⃣ **Socket Tab**
- Connect to socket server with authenticated token
- See socket connection status with visual indicator
- Join created session via socket
- Mark player as ready
- Watch session for readonly access
- Real-time event log

**Status Colors:**
- 🟢 **Green**: Connected
- 🔴 **Red**: Disconnected
- 🟡 **Yellow**: Connecting

### 4️⃣ **Multi-Player Tab**
Test real-time multi-player features:

1. **Tab 1 (Player 1):**
   - Send OTP with phone `9999999999`
   - Verify OTP
   - Create session
   - Copy session code

2. **Tab 2 (Player 2):**
   - Open in new tab/window at `http://localhost:3000/test.html`
   - Send OTP with different phone (e.g., `8888888888`)
   - Verify OTP
   - Paste session code from Tab 1
   - Click "Join"
   - See both players in real-time player list

## Quick Start

### Prerequisites
```bash
# 1. Start Docker containers
docker compose up --build

# 2. Create test database (if needed)
npm run migrate

# 3. Database must have test game and contest
# Or seed with test data:
sqlite3 or psql <<EOF
INSERT INTO games (name, image, rules, max_players) 
VALUES ('Test Rummy', 'https://...', '{}', 4);

INSERT INTO contests (name, game_id, max_players, entry_fee, prize_pool, status)
VALUES ('Test Contest', 1, 4, 0, 0, 'active');
EOF
```

### 3-Minute Test Session

1. **Open in browser:** `http://localhost:3000/test.html`

2. **Follow the numbered tabs:**
   - **Auth Tab**: Send OTP → Verify (code: `1111`) → ✅
   - **Session Tab**: Create session → ✅
   - **Socket Tab**: Connect → Join → Mark Ready → ✅
   - **Event Log**: Watch real-time callbacks

3. **Verify Success:**
   - ✅ All event log entries green/success
   - ✅ Socket status shows "Connected"
   - ✅ Players list updates in real-time

## Event Log Reference

### Success Messages (Green)
```
[HH:MM:SS] ✅ Authentication successful for user 123
[HH:MM:SS] 🎮 Session created: abc12def
[HH:MM:SS] 🔌 Socket connected
[HH:MM:SS] 👋 Joined session abc12def
[HH:MM:SS] ✅ Session state updated: active (2 players)
```

### Error Messages (Red)
```
[HH:MM:SS] ❌ Invalid phone number
[HH:MM:SS] 🎮 Session creation failed: Contest not active
[HH:MM:SS] 🔌 Socket error: Authentication failed
[HH:MM:SS] 👋 Join failed: Session not found
```

## Troubleshooting

### "Session not found" error
**Cause:** Game ID or Contest ID doesn't exist
**Fix:** Check database for test game/contest:
```sql
SELECT id, name FROM games LIMIT 5;
SELECT id, name, game_id FROM contests LIMIT 5;
```

### Socket won't connect
**Cause:** Not authenticated first
**Fix:** Complete auth tab first, return to socket tab

### Events not broadcasting
**Cause:** Socket.IO handshake failed silently
**Check in Browser Console:**
```js
// Open DevTools → Console tab
io.socket = io('http://localhost:3000', {
  auth: { token: 'YOUR_TOKEN' }
});
```

### Can't join session from another tab
**Flow:**
1. Tab 1: Authenticate + Create Session + Copy Code
2. Tab 2: New page → Authenticate → Paste Code in Multi-Player tab
3. Tab 2: Click "Join via Code"
4. Watch both tabs' event logs for sync

## API Endpoints Used

The UI makes requests to:
- `POST /api/auth/send-otp` - Send OTP
- `POST /api/auth/verify-otp` - Verify OTP
- `POST /api/gameplay/sessions` - Create session
- `GET /api/gameplay/sessions/:id` - Fetch session
- `GET /api/gameplay/sessions/code/:code` - Fetch by code
- `POST /api/gameplay/sessions/:id/join` - Join session
- `POST /api/gameplay/sessions/:id/ready` - Mark ready

Plus WebSocket events:
- `session:join` - Join session via socket
- `session:watch` - Watch session updates
- `player:ready` - Mark player ready
- `session:state` - Broadcast (received)

## Browser Compatibility

- ✅ Chrome/Edge 88+
- ✅ Firefox 87+
- ✅ Safari 14+
- ✅ Mobile browsers (full responsive)

## Notes for Development

- Pre-filled test values: phone `9999999999`, OTP `1111`, game ID `1`, contest ID `1`
- All timestamps logged in browser time zone
- Event log auto-scrolls; use "Clear" button to reset
- Multiple socket connections supported (one per tab)

## Known Limitations

- **Single-instance** socket registry (doesn't work across multiple server instances)
  - Fix needed before: multi-region EC2, load-balanced deployments
- **No persistence** of session state changes (Redis caching not yet activated)
  - Sessions sync in DB, but cache misses will show stale state
- **Kafka events** not yet wired to gameplay service
  - For future: wallet settlement, ranking updates

## Next Steps After Testing

1. ✅ Verify socket connects and broadcasts
2. ✅ Test multi-player join/sync
3. → Activate Redis session caching (gameplay.service.js)
4. → Implement turn engine and card actions
5. → Add wallet settlement events

---

**Session Status:** Ready for local testing
**Last Updated:** March 2025
