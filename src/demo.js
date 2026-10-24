import { StoaEngine } from './engine.js';
import { MemoryStore } from './store.js';

const engine = await new StoaEngine({ store: new MemoryStore(), simulationId: 'demo' }).initialize();
const version = engine.snapshot().version;
console.log('Athena:', await engine.submit({ type: 'schedule', actor: 'athena', name: 'catalogue observatory', duration: 3, reads: ['observatory'], writes: ['catalogue'], expectedVersion: version }));
console.log('Pallas:', await engine.submit({ type: 'schedule', actor: 'pallas', name: 'inspect garden', duration: 2, reads: ['garden'], writes: ['notes'], expectedVersion: engine.snapshot().version }));
console.log('Advance:', await engine.submit({ type: 'advance', amount: 2, expectedVersion: engine.snapshot().version }));
console.log(JSON.stringify(engine.snapshot(), null, 2));
