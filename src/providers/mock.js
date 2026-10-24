import { nextStepToward } from '../world.js';

export class DeterministicMockProvider {
  constructor() { this.name = 'deterministic-mock'; this.live = false; }
  propose(state, actorId) {
    const actor = state.actors[actorId];
    if (!actor || actor.status !== 'idle') return null;
    const goals = [...(actor.goals ?? [])].filter((goal) => goal.status !== 'completed')
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
    for (const goal of goals) {
      const steps = goal.steps ?? [];
      const completed = new Set(state.activities.filter((activity) => activity.actor === actorId && activity.status === 'completed' && activity.goalId === goal.id).map((activity) => activity.stepId));
      const step = steps.find((candidate) => goal.repeat || !completed.has(candidate.id));
      if (!step) continue;
      if (step.location && actor.location !== step.location) {
        const destination = nextStepToward(state.locations, actor.location, step.location);
        if (!destination) return null;
        return { goalId: goal.id, rationale: `${actorId} needs to reach ${step.location} before ${step.name}.`, command: {
          type: 'move', actor: actorId, name: destination === step.location ? `go to ${step.location}` : `go toward ${step.location} via ${destination}`, destination,
          reads: [`location:${actor.location}`], writes: [`actor:${actorId}:location`],
          interruptSignals: ['danger', 'request'], goalId: goal.id, stepId: `move:${step.id}`,
          outcome: `${actorId} arrived at ${destination}.`, proposedBy: this.name
        } };
      }
      return { goalId: goal.id, rationale: `${actorId} chose “${step.name}” to advance the goal “${goal.description}”.`, command: {
        type: 'schedule', actor: actorId, name: step.name, location: step.location ?? actor.location,
        duration: step.duration ?? 1, reads: step.reads ?? [], writes: step.writes ?? [],
        interruptSignals: step.interruptSignals ?? ['danger', 'request'], startEffects: step.startEffects ?? {},
        cancelEffects: step.cancelEffects ?? {}, effects: step.effects ?? {}, outcome: step.outcome ?? null,
        goalId: goal.id, stepId: step.id, proposedBy: this.name
      } };
    }
    if ((actor.goals ?? []).length) return null;
    const location = actor.location;
    return { goalId: null, rationale: `${actorId} has no unfinished goal and makes a local observation.`, command: {
      type: 'schedule', actor: actorId, name: `observe ${location}`, location, duration: 1,
      reads: [`location:${location}`], writes: [`notes:${actorId}`], outcome: `${actorId} recorded an observation at ${location}.`,
      effects: { [`last_observation:${actorId}`]: { location, at: state.clock + 1, source: 'deterministic-mock' } }, proposedBy: this.name
    } };
  }
}
