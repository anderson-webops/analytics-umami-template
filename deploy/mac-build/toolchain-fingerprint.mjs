import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function toolchainFingerprint(inspectResult) {
  const image =
    Array.isArray(inspectResult) && inspectResult.length === 1 ? inspectResult[0] : null;
  const layers = image?.RootFS?.Layers;
  const configuration = image?.Config;

  if (
    image?.Os !== 'linux' ||
    image?.Architecture !== 'arm64' ||
    !Array.isArray(layers) ||
    layers.length === 0 ||
    !layers.every(layer => /^sha256:[0-9a-f]{64}$/.test(layer)) ||
    !Array.isArray(configuration?.Env) ||
    !configuration.Env.every(value => typeof value === 'string') ||
    typeof (configuration.User ?? '') !== 'string' ||
    typeof (configuration.WorkingDir ?? '') !== 'string' ||
    (![null, undefined].includes(configuration.Entrypoint) &&
      (!Array.isArray(configuration.Entrypoint) ||
        !configuration.Entrypoint.every(value => typeof value === 'string'))) ||
    (![null, undefined].includes(configuration.Cmd) &&
      (!Array.isArray(configuration.Cmd) ||
        !configuration.Cmd.every(value => typeof value === 'string')))
  ) {
    throw new Error('The Linux ARM64 toolchain inventory is incomplete.');
  }

  const identity = {
    architecture: image.Architecture,
    command: configuration.Cmd ?? null,
    entrypoint: configuration.Entrypoint ?? null,
    environment: configuration.Env,
    layers,
    os: image.Os,
    user: configuration.User ?? '',
    workingDirectory: configuration.WorkingDir ?? '',
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${toolchainFingerprint(JSON.parse(readFileSync(0, 'utf8')))}\n`);
}
