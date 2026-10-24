export class AutonomyController {
  constructor({ engine, provider }) {
    this.engine = engine;
    this.provider = provider;
  }

  async cycle() {
    if (this.engine.snapshot().paused) return { ok: false, reason: 'simulation paused' };
    const before = this.engine.snapshot();
    const decisions = [];

    for (const actorId of Object.keys(before.actors).sort()) {
      const proposal = this.provider.propose(this.engine.snapshot(), actorId);
      if (!proposal) continue;
      const result = await this.engine.submit(proposal.command);
      const decision = {
        actor: actorId,
        goalId: proposal.goalId,
        rationale: proposal.rationale,
        command: proposal.command,
        accepted: result.ok,
        reason: result.ok ? null : result.reason,
        conflicts: result.conflicts ?? []
      };
      decisions.push(decision);
      await this.engine.submit({ type: 'autonomy.decision', decision });
    }

    const active = this.engine.snapshot().activities.filter((activity) => activity.status === 'active');
    if (active.length) {
      const nextAt = Math.min(...active.map((activity) => activity.endAt));
      await this.engine.submit({ type: 'advance', amount: Math.max(1, nextAt - this.engine.snapshot().clock) });
    }

    return { ok: true, decisions, state: this.engine.snapshot(), progressed: decisions.some((item) => item.accepted) || active.length > 0 };
  }

  async run({ maxCycles = 10 } = {}) {
    const limit = Math.max(1, Math.min(100, Number(maxCycles) || 10));
    const cycles = [];
    for (let index = 0; index < limit; index += 1) {
      const result = await this.cycle();
      cycles.push(result);
      if (!result.ok || !result.progressed || this.engine.snapshot().paused) break;
    }
    return { ok: cycles.every((cycle) => cycle.ok), cycles: cycles.length, results: cycles, state: this.engine.snapshot() };
  }
}
