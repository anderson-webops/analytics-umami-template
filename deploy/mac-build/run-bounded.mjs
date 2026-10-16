import { spawn } from 'node:child_process';
import { closeSync, constants, openSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const [logPath, secondsText, bytesText, command, ...arguments_] = process.argv.slice(2);
const seconds = Number(secondsText);
const maxBytes = Number(bytesText);

if (
  !path.isAbsolute(logPath ?? '') ||
  !Number.isSafeInteger(seconds) ||
  seconds < 1 ||
  seconds > 7200 ||
  !Number.isSafeInteger(maxBytes) ||
  maxBytes < 1 ||
  maxBytes > 8 * 1024 * 1024 ||
  !command
) {
  process.stderr.write('Invalid bounded-command parameters.\n');
  process.exitCode = 64;
} else {
  const log = openSync(
    logPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const child = spawn(command, arguments_, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  let bytesWritten = 0;
  let failure;
  let killTimer;
  let metricsWritten = false;

  function recordMetrics(exitCode) {
    if (metricsWritten) return;
    metricsWritten = true;
    writeFileSync(
      `${logPath}.metrics.json`,
      `${JSON.stringify({
        schema_version: 1,
        started_at_utc: startedAt,
        wall_seconds: Number(process.hrtime.bigint() - started) / 1e9,
        output_bytes: bytesWritten,
        exit_code: exitCode,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  }

  function stop(reason) {
    if (failure) return;
    failure = reason;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    killTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      child.stdout.destroy();
      child.stderr.destroy();
      closeSync(log);
      recordMetrics(1);
      process.stderr.write(`${failure}\n`);
      process.exit(1);
    }, 5_000);
  }

  function capture(chunk) {
    if (failure) return;
    if (bytesWritten + chunk.length > maxBytes) {
      stop('Build phase exceeded its retained-output limit.');
      return;
    }
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(log, chunk, offset, chunk.length - offset);
        if (written < 1) throw new Error('Build phase log write stalled.');
        offset += written;
      }
      bytesWritten += chunk.length;
      process.stdout.write(chunk);
    } catch {
      stop('Build phase output could not be stored.');
    }
  }

  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', () => stop('Build phase could not start.'));
  process.on('SIGINT', () => stop('Build phase interrupted.'));
  process.on('SIGTERM', () => stop('Build phase interrupted.'));
  const timer = setTimeout(() => stop('Build phase exceeded its time limit.'), seconds * 1000);
  child.on('close', code => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    closeSync(log);
    try {
      recordMetrics(failure ? 1 : code === 0 ? 0 : code || 1);
    } catch {
      process.stderr.write('Build phase metrics could not be stored.\n');
      process.exitCode = 1;
      return;
    }
    if (failure) process.stderr.write(`${failure}\n`);
    process.exitCode = failure ? 1 : code === 0 ? 0 : code || 1;
  });
}
