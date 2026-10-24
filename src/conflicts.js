const overlap = (a = [], b = []) => a.some((item) => new Set(b).has(item));

export function activitiesConflict(a, b) {
  return overlap(a.writes, b.writes) || overlap(a.writes, b.reads) || overlap(a.reads, b.writes);
}

export function findConflicts(candidate, activeActivities) {
  return activeActivities.filter((active) => activitiesConflict(candidate, active));
}
