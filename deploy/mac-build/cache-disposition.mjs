const [kind, sizeText, ageText] = process.argv.slice(2);
const days = 24 * 60 * 60;
const policies = {
  pnpm: { maxSizeKiB: 2 * 1024 * 1024, maxIdleSeconds: 90 * days },
  compiler: { maxSizeKiB: 512 * 1024, maxIdleSeconds: 30 * days },
};

function parseNonnegativeInteger(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? '')) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

const sizeKiB = parseNonnegativeInteger(sizeText);
const ageSeconds = parseNonnegativeInteger(ageText);
const policy = Object.hasOwn(policies, kind ?? '') ? policies[kind] : undefined;

if (!policy || sizeKiB === undefined || ageSeconds === undefined) {
  console.error('Invalid builder cache measurement.');
  process.exitCode = 64;
} else {
  const stale = ageSeconds > policy.maxIdleSeconds;
  const oversizedAndIdle = sizeKiB > policy.maxSizeKiB && ageSeconds > 7 * days;
  process.stdout.write(stale || oversizedAndIdle ? 'eligible' : 'retain');
}
