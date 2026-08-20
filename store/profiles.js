/**
 * User Profiles Store — Persistent user profiles with interests, tags, and projects
 *
 * Stores rich user data for matchmaking:
 * - What they're building
 * - Interests (broad topics they care about) 
 * - Tags (specific skills/technologies)
 * - Activity patterns
 * - Connection history
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const PROFILES_FILE = path.join(config.VIBE_DIR, 'profiles.json');

// Load all profiles from disk
function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      const data = fs.readFileSync(PROFILES_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn('Failed to load profiles:', e.message);
  }
  return {};
}

// Save all profiles to disk
function saveProfiles(profiles) {
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
  } catch (e) {
    console.error('Failed to save profiles:', e.message);
  }
}

// Get a single user's profile
async function getProfile(handle) {
  const profiles = loadProfiles();
  const key = handle.toLowerCase().replace('@', '');
  
  return profiles[key] || {
    handle: key,
    building: null,
    interests: [],
    tags: [],
    lastSeen: null,
    firstSeen: null,
    connections: [],
    ships: []
  };
}

// Update user profile
async function updateProfile(handle, updates) {
  const profiles = loadProfiles();
  const key = handle.toLowerCase().replace('@', '');

  const existing = profiles[key] || {
    handle: key,
    building: null,
    interests: [],
    tags: [],
    lastSeen: null,
    firstSeen: null,
    connections: [],
    ships: []
  };

  // Merge updates
  const updated = { ...existing, ...updates };

  // Ensure arrays are properly formatted
  if (updates.interests) {
    updated.interests = Array.isArray(updates.interests)
      ? updates.interests
      : updates.interests.split(',').map(s => s.trim()).filter(s => s);

    // IMPORTANT: Clear inferred flag when user explicitly sets interests
    // This prevents inferMissingInterests() from overwriting explicit choices
    updated.interests_inferred = false;
  }

  if (updates.tags) {
    updated.tags = Array.isArray(updates.tags)
      ? updates.tags
      : updates.tags.split(',').map(s => s.trim()).filter(s => s);
  }

  // Update timestamps
  updated.lastSeen = Date.now();
  if (!existing.firstSeen) {
    updated.firstSeen = Date.now();
  }

  profiles[key] = updated;
  saveProfiles(profiles);

  return updated;
}

// Get all profiles
async function getAllProfiles() {
  const profiles = loadProfiles();
  return Object.values(profiles);
}

// Record a connection between users
async function recordConnection(from, to, reason) {
  const profiles = loadProfiles();
  const fromKey = from.toLowerCase().replace('@', '');
  const toKey = to.toLowerCase().replace('@', '');
  
  const connection = {
    timestamp: Date.now(),
    reason,
    suggested_by: 'discovery-agent'
  };
  
  // Add to both profiles
  if (!profiles[fromKey]) profiles[fromKey] = createEmptyProfile(fromKey);
  if (!profiles[toKey]) profiles[toKey] = createEmptyProfile(toKey);
  
  if (!profiles[fromKey].connections) profiles[fromKey].connections = [];
  if (!profiles[toKey].connections) profiles[toKey].connections = [];
  
  profiles[fromKey].connections.push({ handle: toKey, ...connection });
  profiles[toKey].connections.push({ handle: fromKey, ...connection });
  
  saveProfiles(profiles);
}

// Record when someone ships something
async function recordShip(handle, what) {
  const profiles = loadProfiles();
  const key = handle.toLowerCase().replace('@', '');
  
  if (!profiles[key]) {
    profiles[key] = createEmptyProfile(key);
  }
  
  if (!profiles[key].ships) {
    profiles[key].ships = [];
  }
  
  profiles[key].ships.unshift({
    what,
    timestamp: Date.now()
  });
  
  // Keep only last 10 ships
  profiles[key].ships = profiles[key].ships.slice(0, 10);
  
  saveProfiles(profiles);
}

// Update last seen time
async function updateLastSeen(handle) {
  const profiles = loadProfiles();
  const key = handle.toLowerCase().replace('@', '');
  
  if (profiles[key]) {
    profiles[key].lastSeen = Date.now();
    saveProfiles(profiles);
  }
}

// Get connection history between two users
async function getConnectionHistory(handle1, handle2) {
  const profile = await getProfile(handle1);
  const key2 = handle2.toLowerCase().replace('@', '');
  
  return profile.connections?.filter(c => c.handle === key2) || [];
}

// Check if users have been connected before
async function hasBeenConnected(handle1, handle2) {
  const history = await getConnectionHistory(handle1, handle2);
  return history.length > 0;
}

// Get users by interest
async function getUsersByInterest(interest) {
  const profiles = await getAllProfiles();
  const searchTerm = interest.toLowerCase();
  
  return profiles.filter(p => 
    p.interests?.some(i => i.toLowerCase().includes(searchTerm))
  );
}

// Get users by tag
async function getUsersByTag(tag) {
  const profiles = await getAllProfiles();
  const searchTerm = tag.toLowerCase();
  
  return profiles.filter(p => 
    p.tags?.some(t => t.toLowerCase().includes(searchTerm))
  );
}

// Get trending interests
async function getTrendingInterests() {
  const profiles = await getAllProfiles();
  const interestCount = {};
  
  for (const profile of profiles) {
    if (profile.interests) {
      for (const interest of profile.interests) {
        interestCount[interest] = (interestCount[interest] || 0) + 1;
      }
    }
  }
  
  return Object.entries(interestCount)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10)
    .map(([interest, count]) => ({ interest, count }));
}

// Get trending tags  
async function getTrendingTags() {
  const profiles = await getAllProfiles();
  const tagCount = {};
  
  for (const profile of profiles) {
    if (profile.tags) {
      for (const tag of profile.tags) {
        tagCount[tag] = (tagCount[tag] || 0) + 1;
      }
    }
  }
  
  return Object.entries(tagCount)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 15)
    .map(([tag, count]) => ({ tag, count }));
}

// Create empty profile structure
function createEmptyProfile(handle) {
  return {
    handle,
    building: null,
    interests: [],
    tags: [],
    lastSeen: Date.now(),
    firstSeen: Date.now(),
    connections: [],
    ships: []
  };
}

// Clean up old profiles (for maintenance)
async function cleanupOldProfiles(daysThreshold = 30) {
  const profiles = loadProfiles();
  const cutoff = Date.now() - (daysThreshold * 24 * 60 * 60 * 1000);

  let cleaned = 0;
  for (const [key, profile] of Object.entries(profiles)) {
    if (profile.lastSeen && profile.lastSeen < cutoff) {
      delete profiles[key];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    saveProfiles(profiles);
  }

  return cleaned;
}

/**
 * Sync profile data from API presence
 * Called after fetching active users to keep local profiles up-to-date
 *
 * @param {Array} presenceData - Array of user objects from /api/presence
 * @returns {number} Number of profiles synced
 */
async function syncFromPresence(presenceData) {
  if (!presenceData || !Array.isArray(presenceData)) return 0;

  const profiles = loadProfiles();
  let changed = false;
  let buildingsUpdated = 0;

  for (const user of presenceData) {
    // Skip users without a handle
    if (!user.handle && !user.username) continue;

    const handle = user.handle || user.username;
    const key = handle.toLowerCase().replace('@', '');

    // Create profile if it doesn't exist
    const isNew = !profiles[key];
    if (isNew) {
      profiles[key] = createEmptyProfile(key);
      changed = true;
    }

    // Sync building description (one_liner from presence)
    const building = user.one_liner || user.workingOn;
    if (building && building !== profiles[key].building) {
      profiles[key].building = building;
      buildingsUpdated++;
      changed = true;
    }

    // Update timestamps (always sync these)
    if (user.lastSeen) {
      const ts = typeof user.lastSeen === 'number'
        ? user.lastSeen
        : new Date(user.lastSeen).getTime();
      // Only update if valid and different
      if (!isNaN(ts) && ts !== profiles[key].lastSeen) {
        profiles[key].lastSeen = ts;
        changed = true;
      }
    }
    if (user.firstSeen && !profiles[key].firstSeen) {
      const ts = typeof user.firstSeen === 'number'
        ? user.firstSeen
        : new Date(user.firstSeen).getTime();
      if (!isNaN(ts)) {
        profiles[key].firstSeen = ts;
        changed = true;
      }
    }

    // Sync mood if present and different
    if (user.mood && user.mood !== profiles[key].mood) {
      profiles[key].mood = user.mood;
      changed = true;
    }
  }

  // Only write if something actually changed
  if (changed) {
    saveProfiles(profiles);
    if (buildingsUpdated > 0) {
      console.error(`[profiles] Synced ${buildingsUpdated} building descriptions from presence`);
    }
  }

  return buildingsUpdated;
}

/**
 * Infer interests from building descriptions for profiles that don't have them
 * Uses suggestInterestsFromBuilding() from _discovery.js
 *
 * @returns {number} Number of profiles with newly inferred interests
 */
async function inferMissingInterests() {
  // Import discovery module (lazy load to avoid circular deps)
  let suggestInterestsFromBuilding;
  try {
    const discovery = require('../tools/_discovery');
    suggestInterestsFromBuilding = discovery.suggestInterestsFromBuilding;
  } catch (e) {
    console.error('[profiles] Failed to load discovery module:', e.message);
    return 0;
  }

  const profiles = loadProfiles();
  let inferred = 0;
  let changed = false;

  for (const [key, profile] of Object.entries(profiles)) {
    // Skip if user has explicit (non-inferred) interests
    if (profile.interests?.length > 0 && !profile.interests_inferred) {
      continue;
    }

    // Infer from building description
    if (profile.building) {
      const suggested = suggestInterestsFromBuilding(profile.building);
      if (suggested.length > 0) {
        // Only update if interests actually changed (avoid repeated writes)
        const existingInterests = (profile.interests || []).slice().sort().join(',');
        const newInterests = suggested.slice().sort().join(',');

        if (existingInterests !== newInterests) {
          profiles[key].interests = suggested;
          profiles[key].interests_inferred = true; // Mark as auto-generated
          profiles[key].interests_updated_at = Date.now();
          inferred++;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    saveProfiles(profiles);
    console.error(`[profiles] Inferred interests for ${inferred} profiles`);
  }

  return inferred;
}

/**
 * Get profiles with inferred interests for discovery
 * Combines explicit and inferred interests
 *
 * @returns {Array} All profiles with interests (explicit or inferred)
 */
async function getProfilesWithInterests() {
  const profiles = await getAllProfiles();
  return profiles.filter(p => p.interests?.length > 0);
}

module.exports = {
  getProfile,
  updateProfile,
  getAllProfiles,
  recordConnection,
  recordShip,
  updateLastSeen,
  getConnectionHistory,
  hasBeenConnected,
  getUsersByInterest,
  getUsersByTag,
  getTrendingInterests,
  getTrendingTags,
  cleanupOldProfiles,
  // Presence sync (Phase 1)
  syncFromPresence,
  inferMissingInterests,
  getProfilesWithInterests
};