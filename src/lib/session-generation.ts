export function hasCurrentSessionGeneration(sessionGeneration: unknown, currentGeneration: number) {
  const generation = sessionGeneration === undefined ? 0 : sessionGeneration;

  return (
    Number.isSafeInteger(generation) &&
    Number.isSafeInteger(currentGeneration) &&
    Number(generation) >= 0 &&
    currentGeneration >= 0 &&
    generation === currentGeneration
  );
}
