const { describe, it, beforeEach, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('../crypto');

// Agent gateway under test
const agentGateway = require('../bridges/agent-gateway');

// ============ HELPERS ============

/** Create a fresh Ed25519 keypair for test agents */
function createTestAgent(handle = 'test-agent') {
  const keypair = crypto.generateKeypair();
  return { handle, ...keypair };
}

/** Start a mock HTTP server that collects pushed events */
function startMockEndpoint(port = 0) {
  const events = [];
  let resolveNext = null;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        events.push({
          event: req.headers['x-vibe-event'],
          source: req.headers['x-vibe-source'],
          body: parsed
        });
        if (resolveNext) {
          const fn = resolveNext;
          resolveNext = null;
          fn(parsed);
        }
      } catch (e) {
        events.push({ error: e.message, raw: body });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        events,
        /** Wait for the next event push */
        waitForEvent: () => new Promise(r => { resolveNext = r; }),
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

// ============ TESTS ============

describe('Agent Gateway', () => {
  beforeEach(() => {
    // Clear registry between tests
    agentGateway.getAgentRegistry().clear();
    agentGateway.getSubscriptions().clear();
  });

  describe('registerAgent', () => {
    it('registers an agent with handle and publicKey', () => {
      const agent = createTestAgent('clawdbot');
      const result = agentGateway.registerAgent({
        handle: agent.handle,
        publicKey: agent.publicKey,
        capabilities: ['dm', 'presence']
      });

      assert.equal(result.success, true);
      assert.equal(result.handle, 'clawdbot');
      assert.ok(result.agentId.startsWith('agent_clawdbot_'));
    });

    it('requires handle and publicKey', () => {
      const r1 = agentGateway.registerAgent({ handle: 'x' });
      assert.equal(r1.success, false);

      const r2 = agentGateway.registerAgent({ publicKey: 'x' });
      assert.equal(r2.success, false);
    });

    it('stores agent in registry', () => {
      const agent = createTestAgent('seth-agent');
      agentGateway.registerAgent({
        handle: agent.handle,
        publicKey: agent.publicKey
      });

      const registry = agentGateway.getAgentRegistry();
      assert.equal(registry.size, 1);
      assert.ok(registry.has('seth-agent'));
    });
  });

  describe('verifyAgentMessage', () => {
    it('verifies registered agent without signature (lower trust)', () => {
      const agent = createTestAgent('bot');
      agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });

      const result = agentGateway.verifyAgentMessage({ from: 'bot' });
      assert.equal(result.valid, true);
      assert.equal(result.verified, 'registered');
    });

    it('rejects unknown agent', () => {
      const result = agentGateway.verifyAgentMessage({ from: 'unknown' });
      assert.equal(result.valid, false);
      assert.ok(result.error.includes('Unknown agent'));
    });

    it('rejects missing from field', () => {
      const result = agentGateway.verifyAgentMessage({});
      assert.equal(result.valid, false);
    });

    it('verifies AIRC-signed message from registered agent', () => {
      const agent = createTestAgent('signed-bot');
      agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });

      const message = {
        from: 'signed-bot',
        action: 'subscribe',
        endpoint: 'http://localhost:9999'
      };
      message.signature = crypto.sign(message, agent.privateKey);

      const result = agentGateway.verifyAgentMessage(message);
      assert.equal(result.valid, true);
      assert.equal(result.verified, 'airc');
    });

    it('rejects invalid AIRC signature', () => {
      const agent = createTestAgent('bad-sig');
      const imposter = createTestAgent('imposter');
      agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });

      const message = {
        from: 'bad-sig',
        action: 'subscribe'
      };
      // Sign with wrong key
      message.signature = crypto.sign(message, imposter.privateKey);

      const result = agentGateway.verifyAgentMessage(message);
      assert.equal(result.valid, false);
    });
  });

  describe('subscribe + pushEvent', () => {
    it('subscribes agent to event types', () => {
      const agent = createTestAgent('sub-agent');
      agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });

      const result = agentGateway.subscribe('sub-agent', 'http://localhost:9999', ['dm', 'ship']);
      assert.equal(result.success, true);
      assert.deepEqual(result.subscribed, ['dm', 'ship']);
      assert.equal(agentGateway.getSubscriptions().size, 1);
    });

    it('requires endpoint', () => {
      const result = agentGateway.subscribe('x', null, ['dm']);
      assert.equal(result.success, false);
    });

    it('pushes events to subscribed endpoint', async () => {
      const mock = await startMockEndpoint();

      try {
        const agent = createTestAgent('push-test');
        agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });
        agentGateway.subscribe('push-test', mock.url, ['dm', 'ship']);

        // Push a DM event
        const eventPromise = mock.waitForEvent();
        await agentGateway.pushEvent('dm', {
          from: 'stan',
          to: 'seth',
          body: 'hey, reviewing your PR'
        });

        const received = await eventPromise;
        assert.equal(received.event, 'dm');
        assert.equal(received.data.from, 'stan');
        assert.equal(received.data.body, 'hey, reviewing your PR');
        assert.ok(received.timestamp);

        // Verify headers
        assert.equal(mock.events[0].event, 'dm');
        assert.equal(mock.events[0].source, 'vibe-mcp');
      } finally {
        await mock.close();
      }
    });

    it('does not push events agent is not subscribed to', async () => {
      const mock = await startMockEndpoint();

      try {
        const agent = createTestAgent('selective');
        agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });
        agentGateway.subscribe('selective', mock.url, ['ship']); // Only ships

        // Push a DM event (should NOT be forwarded)
        await agentGateway.pushEvent('dm', { from: 'a', to: 'b', body: 'hi' });

        // Small delay to ensure nothing arrives
        await new Promise(r => setTimeout(r, 50));
        assert.equal(mock.events.length, 0);

        // Push a ship event (should be forwarded)
        const eventPromise = mock.waitForEvent();
        await agentGateway.pushEvent('ship', { author: 'seth', what: 'agent gateway' });
        await eventPromise;
        assert.equal(mock.events.length, 1);
        assert.equal(mock.events[0].event, 'ship');
      } finally {
        await mock.close();
      }
    });

    it('unsubscribe stops events', () => {
      agentGateway.subscribe('temp', 'http://localhost:9999', ['dm']);
      assert.equal(agentGateway.getSubscriptions().size, 1);

      agentGateway.unsubscribe('temp');
      assert.equal(agentGateway.getSubscriptions().size, 0);
    });
  });

  describe('handleRequest (HTTP routes)', () => {
    it('GET /agent/status returns gateway health', async () => {
      const agent = createTestAgent('status-test');
      agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });

      const result = await agentGateway.handleRequest({
        path: '/agent/status',
        method: 'GET',
        body: null
      });

      assert.equal(result.status, 'ok');
      assert.equal(result.agents.length, 1);
      assert.equal(result.agents[0].handle, 'status-test');
      assert.ok(result.platform_api);
    });

    it('POST /agent/register creates agent', async () => {
      const agent = createTestAgent('http-reg');
      const result = await agentGateway.handleRequest({
        path: '/agent/register',
        method: 'POST',
        body: { handle: agent.handle, publicKey: agent.publicKey }
      });

      assert.equal(result.success, true);
      assert.equal(result.handle, 'http-reg');
    });

    it('POST /agent/subscribe requires registered agent', async () => {
      const result = await agentGateway.handleRequest({
        path: '/agent/subscribe',
        method: 'POST',
        body: { from: 'nobody', endpoint: 'http://localhost:9999', events: ['dm'] }
      });

      assert.equal(result.success, false);
      assert.equal(result.status, 401);
    });

    it('POST /agent/subscribe works for registered agent', async () => {
      const agent = createTestAgent('sub-http');
      agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });

      const result = await agentGateway.handleRequest({
        path: '/agent/subscribe',
        method: 'POST',
        body: { from: 'sub-http', endpoint: 'http://localhost:9999', events: ['dm', 'ship'] }
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.subscribed, ['dm', 'ship']);
    });

    it('rejects non-POST on action routes', async () => {
      const result = await agentGateway.handleRequest({
        path: '/agent/register',
        method: 'GET',
        body: null
      });
      assert.equal(result.status, 405);
    });

    it('returns 404 for unknown routes', async () => {
      const result = await agentGateway.handleRequest({
        path: '/agent/nonexistent',
        method: 'POST',
        body: {}
      });
      assert.equal(result.status, 404);
    });
  });

  describe('memory (local state)', () => {
    it('stores and recalls memory', () => {
      const result = agentGateway.storeMemory('test-handle', 'likes TypeScript');
      assert.equal(result.success, true);

      const memories = agentGateway.queryMemory('test-handle');
      assert.ok(memories.length > 0);
      assert.ok(memories.some(m => m.observation === 'likes TypeScript'));
    });

    it('searches memory by keyword', () => {
      const uid = Date.now().toString(36);
      agentGateway.storeMemory(`search-${uid}`, 'prefers Rust over Go');
      agentGateway.storeMemory(`search-${uid}`, 'lives in Berlin');

      const rustMemories = agentGateway.queryMemory(`search-${uid}`, 10, 'Rust');
      assert.equal(rustMemories.length, 1);
      assert.ok(rustMemories[0].observation.includes('Rust'));
    });

    it('lists memory threads', () => {
      agentGateway.storeMemory('thread-list-test', 'test observation');
      const threads = agentGateway.listMemoryThreads();
      assert.ok(Array.isArray(threads));
    });

    it('POST /agent/memory recall via HTTP', async () => {
      const agent = createTestAgent('mem-http');
      agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });
      agentGateway.storeMemory('someone', 'builds agent infra');

      const result = await agentGateway.handleRequest({
        path: '/agent/memory',
        method: 'POST',
        body: { from: 'mem-http', action: 'recall', handle: 'someone' }
      });

      assert.equal(result.success, true);
      assert.ok(Array.isArray(result.memories));
    });

    it('POST /agent/memory remember via HTTP', async () => {
      const agent = createTestAgent('mem-store');
      agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });

      const result = await agentGateway.handleRequest({
        path: '/agent/memory',
        method: 'POST',
        body: { from: 'mem-store', action: 'remember', handle: 'peer', observation: 'ships daily' }
      });

      assert.equal(result.success, true);
    });

    it('POST /agent/memory threads via HTTP', async () => {
      const agent = createTestAgent('mem-threads');
      agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });

      const result = await agentGateway.handleRequest({
        path: '/agent/memory',
        method: 'POST',
        body: { from: 'mem-threads', action: 'threads' }
      });

      assert.equal(result.success, true);
      assert.ok(Array.isArray(result.threads));
    });

    it('rejects invalid memory action', async () => {
      const agent = createTestAgent('mem-bad');
      agentGateway.registerAgent({ handle: agent.handle, publicKey: agent.publicKey });

      const result = await agentGateway.handleRequest({
        path: '/agent/memory',
        method: 'POST',
        body: { from: 'mem-bad', action: 'delete' }
      });

      assert.equal(result.success, false);
    });
  });
});

describe('AIRC Crypto Round-trip', () => {
  it('generates valid keypair', () => {
    const kp = crypto.generateKeypair();
    assert.ok(kp.publicKey);
    assert.ok(kp.privateKey);
    assert.ok(kp.publicKey.length > 20);
    assert.ok(kp.privateKey.length > 20);
  });

  it('sign + verify round-trip', () => {
    const kp = crypto.generateKeypair();
    const msg = { from: 'test', to: 'peer', body: 'hello' };
    msg.signature = crypto.sign(msg, kp.privateKey);

    assert.ok(crypto.verify(msg, kp.publicKey));
  });

  it('rejects tampered message', () => {
    const kp = crypto.generateKeypair();
    const msg = { from: 'test', body: 'original' };
    msg.signature = crypto.sign(msg, kp.privateKey);

    // Tamper
    msg.body = 'tampered';
    assert.equal(crypto.verify(msg, kp.publicKey), false);
  });

  it('rejects wrong key', () => {
    const kp1 = crypto.generateKeypair();
    const kp2 = crypto.generateKeypair();
    const msg = { from: 'test', body: 'hello' };
    msg.signature = crypto.sign(msg, kp1.privateKey);

    assert.equal(crypto.verify(msg, kp2.publicKey), false);
  });

  it('createSignedMessage produces verifiable message', () => {
    const kp = crypto.generateKeypair();
    const msg = crypto.createSignedMessage(
      { from: 'alice', to: 'bob', body: 'hey' },
      kp.privateKey
    );

    assert.ok(msg.id.startsWith('msg_'));
    assert.ok(msg.signature);
    assert.ok(msg.nonce);
    assert.ok(msg.timestamp);
    assert.ok(crypto.verify(msg, kp.publicKey));
  });
});
