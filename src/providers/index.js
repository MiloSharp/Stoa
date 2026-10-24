import { DeterministicMockProvider } from './mock.js';
export { SubscriptionAi } from './ai.js';

export function createProvider(name = 'mock') {
  if (name !== 'mock') throw new Error(`Provider ${name} is unavailable; only deterministic mock is enabled`);
  return new DeterministicMockProvider();
}
