import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../src/providers/index.js';
import { SubscriptionAi } from '../src/providers/ai.js';
import { voiceProfiles } from '../src/voice-profiles.js';

test('provider boundary exposes deterministic mock with live calls disabled', () => {
  const provider = createProvider('mock');
  const proposal = provider.propose({ clock: 4, actors: { athena: { id: 'athena', status: 'idle', location: 'Archive' } } }, 'athena');
  assert.equal(provider.live, false); assert.equal(proposal.command.actor, 'athena'); assert.equal(proposal.command.duration, 1);
  assert.equal(proposal.command.effects['last_observation:athena'].at, 5);
});

test('subscription assignments use the requested providers without API credentials', async () => {
  const ai = new SubscriptionAi();
  const status = ai.status();
  assert.deepEqual(Object.keys(status), ['athena', 'minerva', 'pallas']);
  assert.match(status.athena.provider, /Gemini/);
  assert.match(status.minerva.provider, /OpenAI/);
  assert.match(status.pallas.provider, /Anthropic/);
  assert.equal(Object.values(status).every((item) => item.connection === 'subscription'), true);
});

test('unknown actors cannot invoke a subscription model', async () => {
  const ai = new SubscriptionAi();
  await assert.rejects(() => ai.propose({}, 'unknown'), /No subscription assignment/);
});

test('each subscription actor has a distinct versioned voice profile', () => {
  assert.deepEqual(Object.keys(voiceProfiles), ['athena', 'minerva', 'pallas']);
  assert.equal(Object.values(voiceProfiles).every((profile) => profile.version && profile.rules.length >= 5), true);
  assert.match(voiceProfiles.athena.rules.join(' '), /Audit-precise/);
  assert.match(voiceProfiles.minerva.rules.join(' '), /craft/);
  assert.match(voiceProfiles.pallas.rules.join(' '), /Impish/);
});
