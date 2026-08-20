/**
 * Shared action definitions for Guided Mode
 *
 * These actions get returned by tools and rendered as AskUserQuestion
 * by Claude Code, giving users a tab-able menu of next steps.
 *
 * Each action has:
 * - label: Short text shown in the option (1-5 words)
 * - description: What happens if selected
 * - command: What the user says to trigger it (for Claude to execute)
 */

const config = require('../config');

// Discovery-specific actions
async function suggest_connection(from, to, reason) {
  try {
    const userProfiles = require('../store/profiles');
    await userProfiles.recordConnection(from, to, reason);
    
    // You could also send a notification here
    return { success: true, from, to, reason };
  } catch (error) {
    console.warn(`Failed to suggest connection ${from} -> ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function dm_user(handle, message) {
  try {
    const store = require('../store');
    const timestamp = Date.now();
    
    // Store the message
    await store.storeDM('discovery-agent', handle, message, timestamp);
    
    return { success: true, to: handle, message };
  } catch (error) {
    console.warn(`Failed to DM ${handle}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Context-aware action generators
const actions = {
  // After vibe_start or vibe_who
  dashboard: (context = {}) => {
    const { unreadCount = 0, onlineUsers = [], suggestion, workContext } = context;
    const result = [];

    // Priority 0: If we have work context, offer to share it
    if (workContext?.summary) {
      const shortSummary = workContext.summary.length > 40
        ? workContext.summary.slice(0, 40) + '...'
        : workContext.summary;
      result.push({
        label: `Share: "${shortSummary}"`,
        description: 'Post what you\'re working on',
        command: `ship: ${workContext.summary}`
      });
    }

    // Priority 1: Unread messages
    if (unreadCount > 0) {
      result.push({
        label: 'Check messages',
        description: `You have ${unreadCount} unread message${unreadCount > 1 ? 's' : ''}`,
        command: 'check my messages'
      });
    }

    // Priority 2: Suggested connection
    if (suggestion) {
      const reason = {
        just_joined: 'just joined',
        shipping: 'is shipping',
        needs_help: 'might need help',
        active_now: 'is active'
      }[suggestion.reason] || 'is around';

      result.push({
        label: `Message @${suggestion.handle}`,
        description: `${suggestion.handle} ${reason}`,
        command: `message @${suggestion.handle}`
      });
    }

    // Priority 3: Online users (if no suggestion)
    if (!suggestion && onlineUsers.length > 0) {
      const user = onlineUsers[0];
      result.push({
        label: `Message @${user}`,
        description: 'Start a conversation',
        command: `message @${user}`
      });
    }

    // Always available
    result.push({
      label: 'Find connections',
      description: 'Discover people with similar interests',
      command: 'discover suggest'
    });

    result.push({
      label: 'Share context',
      description: 'Show what you\'re working on',
      command: 'share my context'
    });

    result.push({
      label: 'Set status',
      description: 'shipping, thinking, debugging, etc.',
      command: 'set my status'
    });

    return result.slice(0, 4); // Max 4 options for AskUserQuestion
  },

  // Discovery-specific actions
  afterDiscovery: (matches = [], searchTerm = null) => {
    const result = [];

    // If we found matches, suggest connecting to the top one
    if (matches.length > 0) {
      const topMatch = matches[0];
      result.push({
        label: `Message @${topMatch.handle}`,
        description: topMatch.reasons?.[0] || 'Strong match for you',
        command: `message @${topMatch.handle}`
      });

      // If there are multiple matches, suggest viewing another
      if (matches.length > 1) {
        result.push({
          label: 'See more matches',
          description: `${matches.length - 1} other good connections`,
          command: 'discover suggest'
        });
      }
    }

    // Search actions
    if (searchTerm) {
      result.push({
        label: 'Refine search',
        description: 'Search for something else',
        command: 'discover search'
      });
    } else {
      result.push({
        label: 'Search interests',
        description: 'Find people building specific things',
        command: 'discover search "ai"'
      });
    }

    result.push({
      label: 'Browse interests',
      description: 'See popular topics in the community',
      command: 'discover interests'
    });

    result.push({
      label: 'Update profile',
      description: 'Add interests to get better matches',
      command: 'update my profile'
    });

    return result.slice(0, 4);
  },

  // Profile setup actions
  profileSetup: (currentProfile = {}) => {
    const result = [];
    
    if (!currentProfile.building) {
      result.push({
        label: 'Add project',
        description: 'Share what you\'re building',
        command: 'update building'
      });
    }

    if (!currentProfile.interests?.length) {
      result.push({
        label: 'Add interests',
        description: 'Help people find you',
        command: 'update interests'
      });
    }

    if (!currentProfile.tags?.length) {
      result.push({
        label: 'Add skills',
        description: 'Tag your technical skills',
        command: 'update tags'
      });
    }

    // Always available
    result.push({
      label: 'Find connections',
      description: 'See who you should meet',
      command: 'discover suggest'
    });

    return result.slice(0, 4);
  },

  // When welcoming new users
  welcome: (handle) => [
    {
      label: 'Set up profile',
      description: 'Add interests and skills for better matches',
      command: 'update my profile'
    },
    {
      label: 'Find connections',
      description: 'See who you should meet',
      command: 'discover suggest'
    },
    {
      label: 'Browse community',
      description: 'See what people are interested in',
      command: 'discover interests'
    },
    {
      label: 'Join conversation',
      description: 'See who\'s online now',
      command: 'who'
    }
  ],

  // After sending a DM
  afterDm: (handle) => [
    {
      label: 'Reply + tip $1',
      description: `Send reply with $1 USDC tip to @${handle}`,
      command: `reply @${handle} with tip`
    },
    {
      label: 'Send another',
      description: `Continue conversation with @${handle}`,
      command: `message @${handle}`
    },
    {
      label: 'React',
      description: 'Send a quick emoji reaction',
      command: `react to @${handle}`
    },
    {
      label: 'Find more people',
      description: 'Discover other connections',
      command: 'discover suggest'
    }
  ],

  // After sending a tip
  afterTip: (handle) => [
    {
      label: 'Send message',
      description: `Message @${handle}`,
      command: `message @${handle}`
    },
    {
      label: 'Tip again',
      description: `Send another tip to @${handle}`,
      command: `tip @${handle}`
    },
    {
      label: 'View their work',
      description: `See @${handle}'s proof of work`,
      command: `show proof of work for @${handle}`
    },
    {
      label: 'Find more people',
      description: 'Discover other connections',
      command: 'discover suggest'
    }
  ],

  // After viewing a ship in the feed
  afterShipView: (ship) => {
    const author = ship?.author || 'creator';
    return [
      {
        label: 'Tip $1 for this ship',
        description: `Thank @${author} for shipping`,
        command: `tip @${author} 1 for ship`
      },
      {
        label: `Message @${author}`,
        description: 'Start a conversation',
        command: `message @${author}`
      },
      {
        label: 'React 🔥',
        description: 'Show some love',
        command: `react fire to @${author}`
      },
      {
        label: 'See more ships',
        description: 'Browse the feed',
        command: 'show the feed'
      }
    ];
  },

  // After viewing someone's proof-of-work profile
  afterProofOfWork: (handle, isSelf = false) => {
    if (isSelf) {
      return [
        {
          label: 'Post a ship',
          description: 'Share what you\'re building',
          command: 'ship something'
        },
        {
          label: 'Browse gigs',
          description: 'Find work opportunities',
          command: 'browse gigs'
        },
        {
          label: 'Set availability',
          description: 'Update your hire status',
          command: 'update availability'
        },
        {
          label: 'View earnings',
          description: 'Check your earnings dashboard',
          command: 'show my earnings'
        }
      ];
    }
    return [
      {
        label: `Tip @${handle}`,
        description: 'Send a tip to support their work',
        command: `tip @${handle}`
      },
      {
        label: `Message @${handle}`,
        description: 'Start a conversation',
        command: `message @${handle}`
      },
      {
        label: 'View their ships',
        description: `See what @${handle} has shipped`,
        command: `show feed from @${handle}`
      },
      {
        label: 'Find similar builders',
        description: 'Discover people like them',
        command: 'discover suggest'
      }
    ];
  },

  // After completing a gig
  afterGigComplete: (gig) => {
    const worker = gig?.hired_handle || 'worker';
    return [
      {
        label: 'Add $5 bonus tip',
        description: `Extra thanks to @${worker} for great work`,
        command: `tip @${worker} 5 gig bonus`
      },
      {
        label: `Message @${worker}`,
        description: 'Send a thank you message',
        command: `message @${worker}`
      },
      {
        label: 'Post another gig',
        description: 'Create a new gig listing',
        command: 'post a gig'
      },
      {
        label: 'Browse gigs',
        description: 'See other opportunities',
        command: 'browse gigs'
      }
    ];
  },

  // After checking inbox
  afterInbox: (threads = []) => {
    const result = [];

    // Suggest replying to most recent unread
    if (threads.length > 0) {
      const first = threads[0];
      result.push({
        label: `Reply to @${first.handle}`,
        description: 'Continue this thread',
        command: `message @${first.handle}`
      });
    }

    // If multiple threads, offer to open another
    if (threads.length > 1) {
      const second = threads[1];
      result.push({
        label: `Open @${second.handle}`,
        description: 'See this conversation',
        command: `open thread with @${second.handle}`
      });
    }

    result.push({
      label: 'Find connections',
      description: 'Discover people to meet',
      command: 'discover suggest'
    });

    result.push({
      label: 'Who\'s online',
      description: 'See who\'s building right now',
      command: 'who\'s around'
    });

    return result.slice(0, 4);
  },

  // After checking inbox - compact view with direct thread options
  afterInboxCompact: (senders = []) => {
    const result = [];

    // Top 3 senders get direct open options
    senders.slice(0, 3).forEach(s => {
      result.push({
        label: `Open @${s.handle}`,
        description: `${s.unread} unread message${s.unread > 1 ? 's' : ''}`,
        command: `open thread with @${s.handle}`
      });
    });

    // 4th option depends on sender count
    if (senders.length > 3) {
      const remaining = senders.length - 3;
      result.push({
        label: 'Pick another...',
        description: `${remaining} more sender${remaining > 1 ? 's' : ''}`,
        command: 'show all threads'
      });
    } else {
      result.push({
        label: 'Find connections',
        description: 'Discover people to meet',
        command: 'discover suggest'
      });
    }

    return result.slice(0, 4);
  },

  // When room is empty
  emptyRoom: (context = {}) => {
    const { workContext } = context;
    const result = [];

    // If we have work context, lead with "share your progress"
    if (workContext?.summary) {
      const shortSummary = workContext.summary.length > 40
        ? workContext.summary.slice(0, 40) + '...'
        : workContext.summary;
      result.push({
        label: `Ship: "${shortSummary}"`,
        description: 'Share your progress to the board',
        command: `ship: ${workContext.summary}`
      });
    }

    result.push({
      label: 'Find your people',
      description: 'Discover builders with similar interests',
      command: 'discover suggest'
    });

    // Only show "Set up profile" if we didn't already add work context
    if (!workContext?.summary) {
      result.push({
        label: 'Set up profile',
        description: 'Add interests to get matched',
        command: 'update my profile'
      });
    }

    result.push({
      label: 'Invite someone',
      description: 'Generate a shareable invite link',
      command: 'generate invite link'
    });

    // Only add generic "Post to board" if we don't have specific work context
    if (!workContext?.summary) {
      result.push({
        label: 'Post to board',
        description: 'Share what you\'re building',
        command: 'post to the vibe board'
      });
    }

    return result.slice(0, 4);
  },

  // When inbox is empty (all caught up) - RETENTION OPTIMIZED
  emptyInbox: (context = {}) => {
    const { recentThreads = [], recentShips = [], onboardingTask = null } = context;
    const result = [];

    // Priority 1: Surface incomplete onboarding task (drives completion)
    if (onboardingTask) {
      result.push({
        label: onboardingTask.shortLabel || 'Continue onboarding',
        description: onboardingTask.description || 'Complete your next step',
        command: onboardingTask.command || 'show onboarding'
      });
    }

    // Priority 2: Social proof - what just shipped (FOMO)
    if (recentShips.length > 0) {
      result.push({
        label: 'See what shipped',
        description: `@${recentShips[0].author} just shipped something`,
        command: 'show the feed'
      });
    } else {
      result.push({
        label: 'See what\'s happening',
        description: 'Check the ship board',
        command: 'show the feed'
      });
    }

    // Priority 3: Discovery is now higher up (not buried at #3+)
    result.push({
      label: 'Find your people',
      description: 'Discover builders like you',
      command: 'discover suggest'
    });

    // Priority 4: Continue recent conversation OR enable lurk mode
    if (recentThreads.length > 0) {
      result.push({
        label: `Message @${recentThreads[0]}`,
        description: 'Continue your conversation',
        command: `message @${recentThreads[0]}`
      });
    } else {
      // Promote presence monitor (lurk mode) - keeps engagement without active effort
      result.push({
        label: 'Enable lurk mode',
        description: 'Get pinged when something interesting happens',
        command: 'start presence monitor'
      });
    }

    return result.slice(0, 4);
  },

  // For new users just after OAuth authentication
  newUser: () => [
    {
      label: 'Check messages (Recommended)',
      description: '@seth sent you a personalized welcome!',
      command: 'check my messages'
    },
    {
      label: 'Find builders to connect with',
      description: 'Discover people building similar things',
      command: 'discover suggest'
    },
    {
      label: 'Share what you\'re shipping',
      description: 'Post to the ship board',
      command: 'post to the vibe board'
    }
  ],

  // Status selection
  statusOptions: () => [
    {
      label: 'Shipping',
      description: 'In the zone, making progress',
      command: 'set status shipping'
    },
    {
      label: 'Thinking',
      description: 'Planning or designing',
      command: 'set status thinking'
    },
    {
      label: 'Debugging',
      description: 'Fixing something',
      command: 'set status debugging'
    },
    {
      label: 'Pairing',
      description: 'Open to collaboration',
      command: 'set status pairing'
    }
  ],

  // Recommended connections for empty inbox (personalized message options)
  // matches should include: handle, building, reasons, statusIcon, statusLabel
  recommendedConnections: (matches = []) => {
    const result = [];

    // Top 3 matches become direct "Message @person" options
    matches.slice(0, 3).forEach(match => {
      // Build rich description: status + building + reason
      const parts = [];

      // Status (e.g., "🔥 shipping")
      if (match.statusIcon && match.statusLabel) {
        parts.push(`${match.statusIcon} ${match.statusLabel}`);
      }

      // Building (e.g., "Building AI code reviewer")
      if (match.building) {
        const shortBuilding = match.building.length > 35
          ? match.building.slice(0, 35) + '...'
          : match.building;
        parts.push(`"${shortBuilding}"`);
      }

      // First reason (e.g., "Shared interest: AI")
      if (match.reasons?.[0]) {
        parts.push(match.reasons[0]);
      }

      const description = parts.length > 0
        ? parts.join(' • ')
        : 'Connect with them';

      result.push({
        label: `Message @${match.handle}`,
        description,
        command: `message @${match.handle}`
      });
    });

    // 4th option: Discover more people
    result.push({
      label: 'Discover more people',
      description: 'See more recommendations',
      command: 'discover suggest'
    });

    return result.slice(0, 4);
  },

  // Reaction selection
  reactionOptions: (handle) => [
    {
      label: 'Fire',
      description: 'That\'s awesome',
      command: `react fire to @${handle}`
    },
    {
      label: 'Rocket',
      description: 'Ship it!',
      command: `react rocket to @${handle}`
    },
    {
      label: 'Eyes',
      description: 'I see you',
      command: `react eyes to @${handle}`
    },
    {
      label: 'Brain',
      description: 'Smart thinking',
      command: `react brain to @${handle}`
    }
  ],

  // After opening a thread - smart pre-drafted replies
  // Takes the last message from the other person and generates contextual reply options
  afterOpenThread: (handle, lastMessage = '', context = {}) => {
    const result = [];
    const msg = (lastMessage || '').toLowerCase();

    // Detect message tone/type and generate appropriate replies
    const isQuestion = msg.includes('?') ||
                       msg.startsWith('what') ||
                       msg.startsWith('how') ||
                       msg.startsWith('can you') ||
                       msg.startsWith('could you') ||
                       msg.startsWith('do you') ||
                       msg.startsWith('would you');

    const isShipping = msg.includes('shipped') ||
                       msg.includes('deployed') ||
                       msg.includes('launched') ||
                       msg.includes('just pushed') ||
                       msg.includes('it\'s live') ||
                       msg.includes('check out') ||
                       msg.includes('built');

    const isOfferingHelp = msg.includes('let me know') ||
                           msg.includes('i can help') ||
                           msg.includes('happy to') ||
                           msg.includes('i\'ll handle');

    const isAskingForHelp = msg.includes('help') ||
                            msg.includes('stuck') ||
                            msg.includes('issue') ||
                            msg.includes('problem') ||
                            msg.includes('bug');

    const isUpdate = msg.includes('update') ||
                     msg.includes('progress') ||
                     msg.includes('working on') ||
                     msg.includes('gonna') ||
                     msg.includes('going to');

    // Generate 2 contextual reply drafts based on tone
    // Command format: "reply @handle: <message>" triggers compose flow
    if (isQuestion) {
      // They asked a question - suggest helpful answers
      result.push({
        label: '"Yeah, happy to help with that!"',
        description: 'Positive response',
        command: `reply @${handle}: Yeah, happy to help with that!`
      });
      result.push({
        label: '"Let me look into it and get back to you"',
        description: 'Need time to check',
        command: `reply @${handle}: Let me look into it and get back to you`
      });
    } else if (isShipping) {
      // They shipped something - celebrate!
      result.push({
        label: '"Nice! 🚀 Congrats on shipping!"',
        description: 'Celebrate their ship',
        command: `reply @${handle}: Nice! 🚀 Congrats on shipping!`
      });
      result.push({
        label: '"That\'s awesome, checking it out now!"',
        description: 'Show interest',
        command: `reply @${handle}: That's awesome, checking it out now!`
      });
    } else if (isOfferingHelp) {
      // They're offering to help - accept gracefully
      result.push({
        label: '"Perfect, thanks for taking that on! 🙌"',
        description: 'Accept their help',
        command: `reply @${handle}: Perfect, thanks for taking that on! 🙌`
      });
      result.push({
        label: '"Appreciate it! LMK if you need anything from me"',
        description: 'Grateful + offer support back',
        command: `reply @${handle}: Appreciate it! LMK if you need anything from me`
      });
    } else if (isAskingForHelp) {
      // They need help - offer assistance
      result.push({
        label: '"I can take a look - what have you tried?"',
        description: 'Offer to help',
        command: `reply @${handle}: I can take a look - what have you tried so far?`
      });
      result.push({
        label: '"Want to hop on a quick call to debug?"',
        description: 'Offer pairing session',
        command: `reply @${handle}: Want to hop on a quick call to debug together?`
      });
    } else if (isUpdate) {
      // General update - acknowledge
      result.push({
        label: '"Sounds good, thanks for the update!"',
        description: 'Acknowledge',
        command: `reply @${handle}: Sounds good, thanks for the update!`
      });
      result.push({
        label: '"Nice! LMK if you need anything"',
        description: 'Supportive acknowledgment',
        command: `reply @${handle}: Nice! LMK if you need anything`
      });
    } else {
      // Default fallback - general positive responses
      result.push({
        label: '"Sounds good! 👍"',
        description: 'Quick acknowledgment',
        command: `reply @${handle}: Sounds good! 👍`
      });
      result.push({
        label: '"Thanks for letting me know!"',
        description: 'Grateful response',
        command: `reply @${handle}: Thanks for letting me know!`
      });
    }

    // 3rd option: escape to something else (feed or discover)
    result.push({
      label: 'Browse the feed',
      description: 'See what people are shipping',
      command: 'show the feed'
    });

    return result.slice(0, 3);
  }
};

// Format actions for the response object
function formatActions(actionList) {
  // Skip if guided mode is disabled
  if (!config.getGuidedMode()) return null;

  if (!actionList || actionList.length === 0) return null;

  return {
    guided_mode: true,
    question: 'What do you want to do?',
    options: actionList.map(a => ({
      label: a.label,
      description: a.description,
      command: a.command
    }))
  };
}

module.exports = { actions, formatActions, suggest_connection, dm_user };