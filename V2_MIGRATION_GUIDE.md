# V2 Postgres Migration Guide

**For**: Existing vibe-mcp users upgrading to V2 Postgres messaging
**Required**: Only if your database was created before January 21, 2026

---

## Quick Migration (30 seconds)

```bash
cd /Users/sethstudio1/Projects/vibe-mcp
node migrate-v2.js
```

**That's it!** The migration is:
- ✅ **Idempotent** - Safe to run multiple times
- ✅ **Non-destructive** - All existing messages preserved
- ✅ **Fast** - Completes in milliseconds
- ✅ **Zero downtime** - No service interruption

---

## What This Migration Does

Adds the `thread_id` column to your local SQLite database to support V2 Postgres API features:

**Before**:
```sql
CREATE TABLE messages (
  local_id TEXT PRIMARY KEY,
  server_id TEXT,
  -- ❌ No thread_id
  from_handle TEXT NOT NULL,
  ...
);
```

**After**:
```sql
CREATE TABLE messages (
  local_id TEXT PRIMARY KEY,
  server_id TEXT,
  thread_id TEXT,  -- ✅ Added
  from_handle TEXT NOT NULL,
  ...
);

CREATE INDEX idx_messages_thread_id ON messages(thread_id);  -- ✅ Added
```

---

## When Do You Need This?

**You need to migrate if**:
- Your `~/.vibecodings/sessions.db` was created before V2 integration
- You see errors mentioning "no column named thread_id"
- Messages aren't grouping correctly into threads

**You don't need to migrate if**:
- You're a new user (fresh install)
- You already ran `migrate-v2.js`
- Your database was created after January 21, 2026

### Check If You Need Migration

```bash
# Check if thread_id column exists
sqlite3 ~/.vibecodings/sessions.db "PRAGMA table_info(messages);" | grep thread_id
```

**No output?** → You need to migrate
**Shows "thread_id|TEXT"?** → You're already upgraded

---

## Migration Steps

### 1. Backup (Optional but Recommended)

```bash
# Backup your database
cp ~/.vibecodings/sessions.db ~/.vibecodings/sessions.db.backup
```

### 2. Run Migration

```bash
cd /Users/sethstudio1/Projects/vibe-mcp
node migrate-v2.js
```

**Expected output**:
```
[Migration] Starting V2 schema migration...
[Migration] Database: /Users/sethstudio1/.vibecodings/sessions.db
[Migration] Adding thread_id column...
[Migration] ✅ Successfully added thread_id column and index
[Migration] ✅ Verification passed
[Migration] Column details: {"cid":12,"name":"thread_id",...}
[Migration] Complete!
```

### 3. Verify (Optional)

```bash
# Run test suite to verify everything works
node test-v2-integration.js
```

**Expected**: All tests pass (✅ Passed: 8, ❌ Failed: 0)

---

## What Happens to Existing Messages?

**Existing messages**:
- ✅ Preserved exactly as-is
- ✅ `thread_id` column added (initially NULL)
- ✅ Next API sync will populate thread_id automatically

**New messages**:
- ✅ Will have thread_id from server response
- ✅ Will group correctly into threads

---

## Rollback (If Needed)

If something goes wrong:

```bash
# Restore from backup
cp ~/.vibecodings/sessions.db.backup ~/.vibecodings/sessions.db
```

**Note**: Rolling back means losing V2 functionality, but your messages are safe.

---

## Troubleshooting

### Error: "Database is locked"

**Cause**: Vibe Terminal or MCP server is running

**Fix**:
```bash
# Close all Vibe apps, then retry
node migrate-v2.js
```

### Error: "SQLITE_ERROR: no such table: messages"

**Cause**: Database doesn't exist yet (fresh install)

**Fix**: No migration needed! Your database will be created with V2 schema automatically.

### Migration says "already exists"

**Output**:
```
[Migration] ✅ thread_id column already exists. No migration needed.
```

**Meaning**: You're already on V2! No action needed.

---

## For Developers

### Manual Migration (SQL)

If you prefer to run the SQL directly:

```sql
-- Add thread_id column
ALTER TABLE messages ADD COLUMN thread_id TEXT;

-- Create index
CREATE INDEX idx_messages_thread_id ON messages(thread_id);
```

### Verification Query

```sql
-- Check schema
PRAGMA table_info(messages);

-- Check if any messages have thread_id
SELECT COUNT(*) as with_thread_id
FROM messages
WHERE thread_id IS NOT NULL;
```

---

## Post-Migration

After migrating:

1. **Restart MCP server** (if running)
2. **Send a test message** to verify thread_id is saved
3. **Check database** to see thread_id populated:

```bash
sqlite3 ~/.vibecodings/sessions.db \
  "SELECT local_id, thread_id, from_handle, to_handle, status
   FROM messages
   ORDER BY created_at DESC
   LIMIT 5;"
```

---

## Need Help?

- **Test suite**: `node test-v2-integration.js`
- **Report**: See `V2_INTEGRATION_REPORT.md`
- **API docs**: See `CLIENT_API_GUIDE.md` in vibe-platform repo
- **Issues**: https://github.com/VibeCodingInc/vibe-mcp/issues

---

## Summary

**What**: Adds `thread_id` column to SQLite database
**Why**: Support V2 Postgres API with proper thread grouping
**How**: `node migrate-v2.js`
**Risk**: None (non-destructive, idempotent)
**Time**: < 1 second

**Ready?** Run `node migrate-v2.js` now!
