import { readFileSync } from 'node:fs';

const expectedTarget = '/Volumes/Storage/General Storage/Builder/exchange';
const allowedTypes = new Set(['virtiofs', '9p', 'fuse.sshfs']);

try {
  const input = readFileSync(0, 'utf8');
  if (input.length > 65536) {
    throw new Error('mount report too large');
  }

  const report = JSON.parse(input);
  if (!Array.isArray(report.filesystems) || report.filesystems.length !== 1) {
    throw new Error('unexpected shared mount count');
  }

  const [mount] = report.filesystems;
  if (
    mount.target !== expectedTarget ||
    !allowedTypes.has(mount.fstype) ||
    typeof mount.options !== 'string' ||
    !mount.options.split(',').includes('rw') ||
    Object.hasOwn(mount, 'children')
  ) {
    throw new Error('unexpected shared mount');
  }
} catch {
  console.error('Builder VM must share only the writable Storage exchange directory.');
  process.exitCode = 1;
}
