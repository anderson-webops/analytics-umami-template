import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { validatePublicConfiguration } from '../../scripts/mac-artifact-transport.mjs';

const [configPath, mode, ...command] = process.argv.slice(2);
if (!configPath || !['identity', 'run'].includes(mode)) {
  throw new Error('Usage: public-environment.mjs CONFIG identity | run COMMAND [ARG...]');
}

const configuration = JSON.parse(await fs.readFile(configPath, 'utf8'));
validatePublicConfiguration(configuration, configuration.site, configuration.repository);

if (mode === 'identity') {
  if (command.length) throw new Error('Identity mode takes no command.');
  process.stdout.write(`${configuration.site}\n${configuration.repository}\n`);
} else {
  if (!command.length) throw new Error('Run mode requires a command.');
  const child = spawn(command[0], command.slice(1), {
    env: { ...process.env, ...configuration.environment },
    stdio: 'inherit',
  });
  child.once('error', error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}
