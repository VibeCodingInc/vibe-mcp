/**
 * vibe help — Quick reference for /vibe commands
 */

const config = require('../config');

const definition = {
  name: 'vibe_help',
  description: 'Show available /vibe commands',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

async function handler() {
  const handle = config.getHandle();
  const identity = handle ? `You're **@${handle}**` : 'Not signed in — run `vibe init`';

  return {
    display: `## /vibe — ${identity}

| Command | What it does |
|---------|-------------|
| \`vibe\` | Join the room, see who's online, check inbox |
| \`vibe who\` | See who's building right now |
| \`vibe dm @handle "msg"\` | Send a direct message |
| \`vibe inbox\` | Check your messages |
| \`vibe status shipping\` | Set your mood (shipping, thinking, afk, debugging, pairing, deep) |
| \`vibe ship "what you built"\` | Announce something you shipped |
| \`vibe discover\` | Find people building similar things |
| \`vibe help\` | This screen |

**Install:** \`claude mcp add vibe -- npx -y slashvibe-mcp\`
**Docs:** slashvibe.dev`
  };
}

module.exports = { definition, handler };
