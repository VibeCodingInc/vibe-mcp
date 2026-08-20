'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ACTOR_BUNDLE_VERSION = 1;
const ACTOR_SESSION_FILE = 'actor-session.json';
const ACTOR_LOCK_DIRECTORY = '.actor-session.lock';
const ACTOR_LOCK_OWNER = 'owner.json';
const REFRESH_TOKEN_PATTERN = /^vrt_[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LOCK_WAIT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_MINIMUM_TTL_SECONDS = 30;

class ActorSessionError extends Error {
  constructor(code, options = {}) {
    super(options.message || code);
    this.name = 'ActorSessionError';
    this.code = code;
    this.reason = options.reason || null;
    this.reauthenticate = options.reauthenticate === true;
    this.ambiguous = options.ambiguous === true;
    if (options.cause) this.cause = options.cause;
  }
}

function actorPaths(env = process.env) {
  // One definition of the identity directory (vibe-home.js): a truthy check
  // here treated an empty VIBE_HOME as "not isolated", which is the exact
  // identity-merge vibe-home.js now refuses.
  const { vibeHome } = require('./vibe-home');
  const directory = vibeHome(env);
  return {
    directory,
    sessionFile: path.join(directory, ACTOR_SESSION_FILE),
    lockDirectory: path.join(directory, ACTOR_LOCK_DIRECTORY),
    lockOwner: path.join(directory, ACTOR_LOCK_DIRECTORY, ACTOR_LOCK_OWNER),
  };
}

function parseAccessToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (
      typeof payload.sub !== 'string' ||
      !UUID_PATTERN.test(payload.sub) ||
      typeof payload.sid !== 'string' ||
      !UUID_PATTERN.test(payload.sid) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp)
    ) {
      return null;
    }
    return {
      principalId: payload.sub,
      runtimeId: payload.sid,
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}

function normalizedBundle(input, timestamp) {
  if (!input || typeof input !== 'object') return null;
  const refreshToken = input.refreshToken;
  const principalId = input.principalId;
  const runtimeId = input.runtimeId;
  const handleVersion = input.handleVersion;
  if (
    typeof refreshToken !== 'string' ||
    !REFRESH_TOKEN_PATTERN.test(refreshToken) ||
    typeof principalId !== 'string' ||
    !UUID_PATTERN.test(principalId) ||
    typeof runtimeId !== 'string' ||
    !UUID_PATTERN.test(runtimeId) ||
    typeof handleVersion !== 'string' ||
    !UUID_PATTERN.test(handleVersion)
  ) {
    return null;
  }
  return {
    version: ACTOR_BUNDLE_VERSION,
    refreshToken,
    principalId,
    runtimeId,
    handleVersion,
    updatedAt: new Date(timestamp).toISOString(),
  };
}

function createActorSessionManager(options = {}) {
  const env = options.env || process.env;
  const paths = options.paths || actorPaths(env);
  const fileSystem = options.fs || fs;
  const now = options.now || (() => Date.now());
  const randomId = options.randomUUID || crypto.randomUUID;
  const wait =
    options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const fetchImpl = options.fetch || globalThis.fetch;
  const apiUrl = String(options.apiUrl || env.VIBE_API_URL || 'https://www.slashvibe.dev').replace(
    /\/$/,
    ''
  );
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let accessCache = null;
  let refreshInFlight = null;

  function ensureDirectory() {
    fileSystem.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    fileSystem.chmodSync(paths.directory, 0o700);
  }

  function atomicWriteBundle(bundle) {
    ensureDirectory();
    const temporary = path.join(
      paths.directory,
      `.${ACTOR_SESSION_FILE}.${process.pid}.${randomId()}.tmp`
    );
    let descriptor = null;
    try {
      descriptor = fileSystem.openSync(temporary, 'wx', 0o600);
      fileSystem.writeFileSync(descriptor, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
      fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = null;
      fileSystem.chmodSync(temporary, 0o600);
      fileSystem.renameSync(temporary, paths.sessionFile);
      fileSystem.chmodSync(paths.sessionFile, 0o600);
    } catch (error) {
      if (descriptor !== null) {
        try {
          fileSystem.closeSync(descriptor);
        } catch {}
      }
      try {
        fileSystem.unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }

  function clearUnsafe() {
    accessCache = null;
    try {
      fileSystem.unlinkSync(paths.sessionFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  function readBundle() {
    let parsed;
    try {
      parsed = JSON.parse(fileSystem.readFileSync(paths.sessionFile, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      clearUnsafe();
      throw new ActorSessionError('actor_reauthentication_required', {
        reason: 'actor_bundle_invalid',
        reauthenticate: true,
        cause: error,
      });
    }
    const bundle = normalizedBundle(parsed, now());
    if (!bundle || parsed.version !== ACTOR_BUNDLE_VERSION) {
      clearUnsafe();
      throw new ActorSessionError('actor_reauthentication_required', {
        reason: 'actor_bundle_invalid',
        reauthenticate: true,
      });
    }
    bundle.updatedAt = parsed.updatedAt;
    return bundle;
  }

  function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  function removeStaleLock() {
    let owner = null;
    let age = 0;
    try {
      owner = JSON.parse(fileSystem.readFileSync(paths.lockOwner, 'utf8'));
    } catch {}
    try {
      age = now() - fileSystem.statSync(paths.lockDirectory).mtimeMs;
    } catch {
      return false;
    }
    if (age <= lockStaleMs || (owner?.pid && processIsAlive(Number(owner.pid)))) return false;
    try {
      fileSystem.unlinkSync(paths.lockOwner);
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }
    try {
      fileSystem.rmdirSync(paths.lockDirectory);
      return true;
    } catch {
      return false;
    }
  }

  async function acquireLock() {
    ensureDirectory();
    const deadline = now() + lockWaitMs;
    const nonce = randomId();
    for (;;) {
      let madeLockDirectory = false;
      try {
        fileSystem.mkdirSync(paths.lockDirectory, { mode: 0o700 });
        madeLockDirectory = true;
        fileSystem.writeFileSync(
          paths.lockOwner,
          `${JSON.stringify({ pid: process.pid, nonce, acquiredAt: new Date(now()).toISOString() })}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        );
        return { nonce };
      } catch (error) {
        if (madeLockDirectory) {
          try {
            fileSystem.unlinkSync(paths.lockOwner);
          } catch {}
          try {
            fileSystem.rmdirSync(paths.lockDirectory);
          } catch {}
        }
        if (error?.code !== 'EEXIST') throw error;
        if (removeStaleLock()) continue;
        if (now() >= deadline) {
          throw new ActorSessionError('actor_refresh_busy', { reason: 'lock_timeout' });
        }
        await wait(25);
      }
    }
  }

  function releaseLock(lock) {
    let owner = null;
    try {
      owner = JSON.parse(fileSystem.readFileSync(paths.lockOwner, 'utf8'));
    } catch {}
    if (owner?.nonce !== lock.nonce) return;
    try {
      fileSystem.unlinkSync(paths.lockOwner);
    } catch {}
    try {
      fileSystem.rmdirSync(paths.lockDirectory);
    } catch {}
  }

  async function withLock(operation) {
    const lock = await acquireLock();
    try {
      return await operation();
    } finally {
      releaseLock(lock);
    }
  }

  function cacheAccessToken(token, bundle) {
    const claims = parseAccessToken(token);
    if (
      !claims ||
      claims.principalId !== bundle.principalId ||
      claims.runtimeId !== bundle.runtimeId ||
      claims.expiresAt * 1000 <= now()
    ) {
      throw new ActorSessionError('actor_access_token_invalid', {
        reason: 'access_binding_invalid',
      });
    }
    accessCache = { token, ...claims };
    return token;
  }

  function reauthenticationError(reason, options = {}) {
    return new ActorSessionError('actor_reauthentication_required', {
      reason,
      reauthenticate: true,
      ambiguous: options.ambiguous === true,
      cause: options.cause,
    });
  }

  async function rotate(bundle) {
    if (typeof fetchImpl !== 'function') {
      throw new ActorSessionError('actor_refresh_unavailable', { reason: 'fetch_unavailable' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(`${apiUrl}/api/auth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: bundle.refreshToken,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearUnsafe();
      throw reauthenticationError('refresh_ambiguous', {
        ambiguous: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response || response.status === 401) {
      clearUnsafe();
      throw reauthenticationError('invalid_grant');
    }
    if (!response.ok) {
      clearUnsafe();
      throw reauthenticationError('refresh_ambiguous', { ambiguous: true });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      clearUnsafe();
      throw reauthenticationError('refresh_ambiguous', {
        ambiguous: true,
        cause: error,
      });
    }

    const nextBundle = normalizedBundle(
      {
        refreshToken: payload?.refresh_token,
        principalId: payload?.principal_id,
        runtimeId: payload?.runtime_id,
        handleVersion: payload?.handle_version,
      },
      now()
    );
    if (
      !nextBundle ||
      payload?.token_type !== 'Bearer' ||
      typeof payload?.access_token !== 'string' ||
      nextBundle.principalId !== bundle.principalId ||
      nextBundle.runtimeId !== bundle.runtimeId
    ) {
      clearUnsafe();
      throw reauthenticationError('refresh_response_invalid', { ambiguous: true });
    }

    try {
      cacheAccessToken(payload.access_token, nextBundle);
      atomicWriteBundle(nextBundle);
    } catch (error) {
      clearUnsafe();
      if (error instanceof ActorSessionError && error.reauthenticate) throw error;
      throw reauthenticationError('refresh_persistence_failed', {
        ambiguous: true,
        cause: error,
      });
    }
    return accessCache.token;
  }

  async function installOAuthSession(session) {
    return withLock(async () => {
      const bundle = normalizedBundle(session, now());
      if (!bundle || typeof session?.accessToken !== 'string') {
        throw new ActorSessionError('actor_oauth_bundle_invalid');
      }
      try {
        cacheAccessToken(session.accessToken, bundle);
        atomicWriteBundle(bundle);
      } catch (error) {
        clearUnsafe();
        if (error instanceof ActorSessionError) throw error;
        throw new ActorSessionError('actor_oauth_persistence_failed', { cause: error });
      }
      return {
        principalId: bundle.principalId,
        runtimeId: bundle.runtimeId,
        handleVersion: bundle.handleVersion,
      };
    });
  }

  async function refreshAccessToken(minimumTtlSeconds = DEFAULT_MINIMUM_TTL_SECONDS) {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = withLock(async () => {
      const bundle = readBundle();
      if (!bundle) return null;
      if (
        accessCache &&
        accessCache.principalId === bundle.principalId &&
        accessCache.runtimeId === bundle.runtimeId &&
        accessCache.expiresAt * 1000 > now() + minimumTtlSeconds * 1000
      ) {
        return accessCache.token;
      }
      return rotate(bundle);
    }).finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function getAccessToken(optionsForCall = {}) {
    const minimumTtlSeconds = optionsForCall.minimumTtlSeconds ?? DEFAULT_MINIMUM_TTL_SECONDS;
    if (accessCache) {
      // The durable bundle is also the cross-process stop signal. Another process
      // may have cleared it after an ambiguous/spent refresh; returning a still-live
      // memory token here would let this process perform a delivery transition after
      // the family entered reauthentication. Atomic replacement makes this read safe.
      const bundle = readBundle();
      if (!bundle) {
        accessCache = null;
        return null;
      }
      if (
        accessCache.principalId === bundle.principalId &&
        accessCache.runtimeId === bundle.runtimeId &&
        accessCache.expiresAt * 1000 > now() + minimumTtlSeconds * 1000
      ) {
        return accessCache.token;
      }
    }
    return refreshAccessToken(minimumTtlSeconds);
  }

  async function clearActorSession() {
    return withLock(async () => clearUnsafe());
  }

  return {
    paths,
    clearActorSession,
    getAccessToken,
    installOAuthSession,
    readBundle,
    refreshAccessToken,
  };
}

const actorSession = createActorSessionManager();

module.exports = {
  ACTOR_BUNDLE_VERSION,
  ActorSessionError,
  actorPaths,
  createActorSessionManager,
  getAccessToken: actorSession.getAccessToken,
  installOAuthSession: actorSession.installOAuthSession,
  clearActorSession: actorSession.clearActorSession,
};
