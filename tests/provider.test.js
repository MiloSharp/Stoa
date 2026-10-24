import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../src/providers/index.js';
import { normalizeProposal, SubscriptionAi } from '../src/providers/ai.js';
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

test('subscription movement follows the next connected step and uses exit duration', () => {
  const state = {
    actors: { athena: { id: 'athena', location: 'Archive' } },
    locations: {
      Archive: { name: 'Archive', exits: { Agora: { duration: 2 } } },
      Agora: { name: 'Agora', exits: { Garden: { duration: 3 } } },
      Garden: { name: 'Garden', exits: {} }
    }
  };
  const result = normalizeProposal({
    proposal: { kind: 'movement', name: 'visit garden', location: 'Garden', duration: 20, rationale: 'Inspect it.', intendedOutcome: 'Reach the garden.' },
    actorId: 'athena', state, provider: 'test', model: 'test'
  });
  assert.equal(result.command.destination, 'Agora');
  assert.equal(result.command.duration, 2);
  assert.match(result.command.name, /via Agora/);
});

test('subscription activity in another place becomes a connected travel step', () => {
  const command = normalizeProposal({
    actorId: 'athena', provider: 'openai', model: 'test',
    proposal: { kind: 'activity', name: 'read in the garden', location: 'South Garden', duration: 8, reads: ['garden'], writes: ['notes'] },
    state: {
      actors: { athena: { id: 'athena', location: 'Archive' } },
      locations: {
        Archive: { name: 'Archive', exits: { Agora: { duration: 2 } } },
        Agora: { name: 'Agora', exits: { 'South Garden': { duration: 4 } } },
        'South Garden': { name: 'South Garden', exits: {} }
      }
    }
  }).command;
  assert.equal(command.type, 'move');
  assert.equal(command.destination, 'Agora');
  assert.equal(command.duration, 2);
});
