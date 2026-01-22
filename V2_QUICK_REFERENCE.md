# V2 Integration Quick Reference Card

**One-page guide for V2 Postgres messaging**

---

## Status Check

```bash
# Check if you need migration
sqlite3 ~/.vibecodings/sessions.db "PRAGMA table_info(messages);" | grep thread_id

# No output? Run migration:
node migrate-v2.js

# Verify integration
node test-v2-integration.js
```

---

## Key Files

| File | Purpose |
|------|---------|
| `migrate-v2.js` | Add thread_id column |
| `test-v2-integration.js` | Test V2 integration |
| `store/sqlite.js` | Local message persistence |
| `store/api.js` | V2 API integration |
| `V2_INTEGRATION_REPORT.md` | Full technical report |
| `V2_MIGRATION_GUIDE.md` | Migration instructions |

---

## Database Schema

```sql
-- V2 schema (post-migration)
CREATE TABLE messages (
  local_id TEXT PRIMARY KEY,    -- Local UUID
  server_id TEXT,                -- Server message ID
  thread_id TEXT,                -- ✅ V2: Thread grouping
  from_handle TEXT NOT NULL,
  to_handle TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,          -- pending, sent, delivered, read, failed
  sent_at TEXT,
  delivered_at TEXT,
  read_at TEXT,
  synced_at TEXT,
  retry_count INTEGER DEFAULT 0
);
```

---

## Message Flow

```
1. User sends message
   ↓
2. Save to SQLite (status: pending)
   ↓
3. POST /api/messages
   ↓
4. Extract thread_id from response
   ↓
5. Update SQLite (status: sent, save thread_id)
   ↓
6. Server delivers message
   ↓
7. Next sync updates status: delivered → read
```

---

## V2 API Format

**Send Message Response**:
```json
{
  "success": true,
  "message": {
    "id": "msg_abc123",        // → server_id
    "thread_id": "thread_xyz", // → thread_id ✅
    "from": "alice",
    "to": "bob",
    "body": "Hello!",
    "created_at": "2026-01-21T..."
  }
}
```

**Get Inbox Response**:
```json
{
  "threads": [
    {
      "id": "thread_xyz",      // → thread_id ✅
      "with": "bob",
      "unread": 3,
      "last_message": {
        "id": "msg_abc123",    // → server_id
        "body": "See you!",
        "created_at": "..."
      }
    }
  ]
}
```

---

## Common Queries

```bash
# View recent messages
sqlite3 ~/.vibecodings/sessions.db \
  "SELECT from_handle, to_handle, substr(content, 1, 30), status
   FROM messages
   ORDER BY created_at DESC
   LIMIT 10;"

# Group by thread
sqlite3 ~/.vibecodings/sessions.db \
  "SELECT thread_id, COUNT(*) as msg_count
   FROM messages
   WHERE thread_id IS NOT NULL
   GROUP BY thread_id;"

# Check delivery status
sqlite3 ~/.vibecodings/sessions.db \
  "SELECT status, COUNT(*)
   FROM messages
   GROUP BY status;"

# Find pending messages
sqlite3 ~/.vibecodings/sessions.db \
  "SELECT local_id, from_handle, to_handle, created_at
   FROM messages
   WHERE status = 'pending';"
```

---

## Code Snippets

### Send Message
```javascript
const api = require('./store/api');

// Sends message + saves to SQLite
await api.sendMessage('alice', 'bob', 'Hello!');
```

### Get Thread
```javascript
const api = require('./store/api');

// Returns messages with thread_id
const messages = await api.getThread('alice', 'bob');
```

### Get Inbox
```javascript
const api = require('./store/api');

// Returns threads with unread counts
const inbox = await api.getInbox('alice');
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "no column named thread_id" | Run `node migrate-v2.js` |
| Messages stuck as "pending" | Check network, verify API token |
| thread_id is NULL | Server not responding with V2 format |
| Database locked error | Close Vibe Terminal, retry |
| Test failures | Check V2_INTEGRATION_REPORT.md |

---

## Test Commands

```bash
# Run full test suite
node test-v2-integration.js

# Expected output:
# ✅ Passed:   8
# ❌ Failed:   0
# ⚠️  Warnings: 0
```

---

## Migration Commands

```bash
# Backup (optional)
cp ~/.vibecodings/sessions.db ~/.vibecodings/sessions.db.backup

# Migrate
node migrate-v2.js

# Expected output:
# [Migration] ✅ Successfully added thread_id column and index
# [Migration] ✅ Verification passed
# [Migration] Complete!

# Rollback (if needed)
cp ~/.vibecodings/sessions.db.backup ~/.vibecodings/sessions.db
```

---

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/messages` | Send message |
| GET | `/api/messages?user=X` | Get inbox threads |
| GET | `/api/messages?user=X&with=Y` | Get thread messages |

**Base URL**: https://www.slashvibe.dev/api

---

## Dependencies

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0"  // ✅ Required
  }
}
```

---

## Key Features

✅ **Optimistic UI** - Messages appear instantly
✅ **Offline support** - Queues when offline
✅ **Thread grouping** - Messages grouped by thread_id
✅ **Delivery tracking** - pending → sent → delivered → read
✅ **Cross-client sync** - Works with Vibe Terminal
✅ **Fast queries** - Indexed for performance

---

## Status Values

| Status | Meaning |
|--------|---------|
| `pending` | Saved locally, not yet sent |
| `sent` | Sent to server, not yet delivered |
| `delivered` | Delivered to recipient |
| `read` | Recipient opened the message |
| `failed` | Send failed (network error, etc.) |

---

## Important Notes

- Migration is **idempotent** (safe to run multiple times)
- Migration is **non-destructive** (all data preserved)
- Database shared with Vibe Terminal (use WAL mode)
- thread_id initially NULL for old messages (gets populated on next sync)

---

## Links

- **Full Report**: `V2_INTEGRATION_REPORT.md`
- **Migration Guide**: `V2_MIGRATION_GUIDE.md`
- **API Docs**: `/Users/sethstudio1/Projects/vibe-platform/CLIENT_API_GUIDE.md`
- **Issues**: https://github.com/VibeCodingInc/vibe-mcp/issues

---

**Last Updated**: January 21, 2026
**Status**: ✅ Production Ready
