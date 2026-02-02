/**
 * vibe follow/unfollow — Follow and unfollow creators
 *
 * vibe_follow: Follow a creator to see their updates
 * vibe_unfollow: Unfollow a creator
 */

const { requireInit, normalizeHandle } = require('./_shared');
const config = require('../config');
const store = require('../store');

const followDefinition = {
  name: 'vibe_follow',
  description: 'Follow a creator to see their updates, ships, and sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Who to follow (e.g., @stan)'
      }
    },
    required: ['handle']
  }
};

const unfollowDefinition = {
  name: 'vibe_unfollow',
  description: 'Unfollow a creator.',
  inputSchema: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description: 'Who to unfollow (e.g., @stan)'
      }
    },
    required: ['handle']
  }
};

async function followHandler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const myHandle = config.getHandle();
  const them = normalizeHandle(args.handle);

  if (them === myHandle) {
    return { display: "You can't follow yourself." };
  }

  const result = await store.followUser(myHandle, them);

  if (result.success === false) {
    return { display: `Failed to follow @${them}: ${result.error || 'Unknown error'}` };
  }

  if (result.message === 'Already following') {
    return { display: `You're already following **@${them}**.` };
  }

  const counts = result.counts || {};
  let display = `Now following **@${them}**`;
  if (counts.youAreFollowing) {
    display += ` (following ${counts.youAreFollowing} people)`;
  }

  return { display };
}

async function unfollowHandler(args) {
  const initCheck = requireInit();
  if (initCheck) return initCheck;

  const myHandle = config.getHandle();
  const them = normalizeHandle(args.handle);

  if (them === myHandle) {
    return { display: "You can't unfollow yourself." };
  }

  const result = await store.unfollowUser(myHandle, them);

  if (result.success === false) {
    return { display: `Failed to unfollow @${them}: ${result.error || 'Unknown error'}` };
  }

  const counts = result.counts || {};
  let display = `Unfollowed **@${them}**`;
  if (counts.youAreFollowing != null) {
    display += ` (following ${counts.youAreFollowing} people)`;
  }

  return { display };
}

module.exports = {
  follow: { definition: followDefinition, handler: followHandler },
  unfollow: { definition: unfollowDefinition, handler: unfollowHandler }
};
