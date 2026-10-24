# Stoa Engine v0.6

A local-first autonomous simulation prototype with durable PostgreSQL snapshots/events, explicit actor goals, inspectable deterministic planning, approval-gated multi-provider AI proposals, conflict-aware concurrent activities, simulated time, connected world topology, timed movement, meaningful interrupts, scenario-defined worlds, named runs, private actor views, and a browser dashboard. Live model/provider calls are disabled by default.

## Quick start

Requirements: Node.js 20+ and PostgreSQL 14+.

```powershell
Copy-Item .env.example .env
npm install
npm run migrate
npm test
npm start
```

Open `http://127.0.0.1:8787`. `npm run demo` exercises the engine without PostgreSQL.

## PostgreSQL

Create an empty database, set `DATABASE_URL`, and run `npm run migrate`. The server loads the most recent snapshot and replays later events. Each accepted command appends its events and a snapshot in one database transaction. The in-memory store used by tests implements the same persistence contract.

## Scheduling model

Activities declare the resources they read and write. Independent activities may be scheduled from the same world version and run concurrently. Overlapping writes, or a write overlapping another activity's read, produce a conflict. An activity completes when simulated time reaches its end. Events with matching interrupt signals may cancel, pause, or reschedule active work; irrelevant signals do nothing.

The dashboard keeps simulated time and its advance control in a sticky strip, can approve all pending AI proposals, and can run the subscription-backed actors for a bounded number of AI cycles—either auto-approving valid proposals or stopping for manual approval. It can also show each actor's goals and reasons, create and select named runs, load scenario JSON, start activities or movement, apply immediate start effects and completion outcomes, resume and cancel paused work, inspect people and locations, and review the journal and event stream. The repetitive deterministic planner remains collapsed as a development-only fallback. The dashboard binds to loopback by default and has no authentication, so do not expose it publicly.

By default, completing an activity automatically asks that same actor's subscription model for a new proposal. The request is skipped if the actor is busy, already thinking, already has a pending proposal, or is inside the bounded multi-cycle runner. Follow-up proposals still wait for approval and can be disabled from the dashboard.

Scenario actors may include `goals`. Each goal has an `id`, `description`, `priority`, and ordered `steps`. A goal with `repeat: true` becomes an ongoing routine after higher-priority finite projects are complete. Steps may use the same location, duration, reads, writes, effects, outcome, and interrupt fields as manually scheduled activities. The deterministic planner moves actors where needed and chooses the highest-priority available goal.

## World topology

Locations may declare directed `exits`. Each exit names an adjacent destination and its positive integer travel duration. Movement is allowed only across a direct exit, takes the exit's duration regardless of a proposed duration, and changes the actor's location only when that travel completes. Activities must occur at the actor's current location, so they cannot bypass the topology. Both the deterministic and subscription-backed planners can target a more distant location; Stoa finds a route and schedules only the next connected step.

```json
{
  "locations": [
    { "name": "Agora", "exits": { "Archive": { "duration": 1 }, "South Garden": { "duration": 1 } } },
    { "name": "Archive", "exits": { "Agora": { "duration": 1 } } },
    { "name": "South Garden", "exits": { "Agora": { "duration": 1 } } }
  ]
}
```

Exits are one-way unless the reverse exit is also declared. For backward compatibility, a scenario with no `exits` field anywhere retains the earlier fully connected behavior with one-tick travel. As soon as any location declares `exits`, omitted exit lists are treated as empty.

## Safety boundary

AI proposals use the computer's already-authenticated subscription command-line clients, not provider APIs: Athena uses Google Antigravity/Gemini, Minerva uses Codex/GPT, and Pallas uses Claude CLI. No API keys are stored by Stoa. Each client runs non-interactively, with project writes and approval prompts disabled. The dashboard reports queued thinking and completion states while calls run. Actors see public activity, nearby people, pending intentions, and their own recent actions; they are explicitly encouraged to vary routines and initiate useful social interaction. An interaction names its partner and Stoa enforces shared location and exclusive attention. Movement dependencies are assigned by Stoa rather than trusted to model output, preventing unrelated world resources from blocking travel. Provider output is normalized into a bounded command, persisted as pending, and cannot change the world until approved. Stoa remains the authority for conflicts, permissions, time, and consequences. Demiurge project files are neither imported nor modified.

Dialogue is textual and character-specific. Each actor receives a compact, versioned runtime voice profile derived from the current Demiurge voice canon: Athena's audit precision, Minerva's relational craft register, and Pallas's impish, technically competent, emotionally evasive register. Exact spoken text is stored with the interaction and entered into the journal on completion. Stoa copies these profiles into its own source and never reads or changes Demiurge at runtime.
