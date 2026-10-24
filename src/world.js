const durationOf = (value) => Number(typeof value === 'number' ? value : value?.duration);

export function normalizeTopology(locations, { legacyComplete = false } = {}) {
  const result = structuredClone(locations ?? {});
  const names = Object.keys(result);
  const hasExplicitTopology = names.some((name) => Object.hasOwn(result[name] ?? {}, 'exits'));
  for (const name of names) {
    const location = result[name] ?? { name };
    location.name ??= name;
    if (!Object.hasOwn(location, 'exits')) {
      location.exits = legacyComplete && !hasExplicitTopology
        ? Object.fromEntries(names.filter((other) => other !== name).map((other) => [other, { duration: 1 }]))
        : {};
    } else {
      location.exits = Object.fromEntries(Object.entries(location.exits ?? {}).map(([destination, exit]) => [
        destination,
        { ...(typeof exit === 'object' && exit !== null ? structuredClone(exit) : {}), duration: durationOf(exit) }
      ]));
    }
    result[name] = location;
  }
  return result;
}

export function topologyError(locations) {
  const names = new Set(Object.keys(locations ?? {}));
  for (const [origin, location] of Object.entries(locations ?? {})) {
    for (const [destination, exit] of Object.entries(location.exits ?? {})) {
      if (!names.has(destination)) return `exit from ${origin} references unknown destination ${destination}`;
      if (destination === origin) return `exit from ${origin} cannot lead to itself`;
      if (!Number.isInteger(exit.duration) || exit.duration <= 0) return `exit from ${origin} to ${destination} requires a positive integer duration`;
    }
  }
  return null;
}

export function directExit(locations, origin, destination) {
  return locations?.[origin]?.exits?.[destination] ?? null;
}

export function routeBetween(locations, origin, destination) {
  if (!locations?.[origin] || !locations?.[destination]) return null;
  if (origin === destination) return [origin];
  const queue = [[origin]];
  const visited = new Set([origin]);
  while (queue.length) {
    const route = queue.shift();
    const current = route.at(-1);
    for (const next of Object.keys(locations[current]?.exits ?? {}).sort()) {
      if (visited.has(next)) continue;
      const candidate = [...route, next];
      if (next === destination) return candidate;
      visited.add(next);
      queue.push(candidate);
    }
  }
  return null;
}

export function nextStepToward(locations, origin, destination) {
  return routeBetween(locations, origin, destination)?.[1] ?? null;
}
