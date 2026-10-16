import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./run-bounded.mjs', import.meta.url));

function run(logPath, seconds, bytes, source) {
  return spawnSync(
    process.execPath,
    [script, logPath, seconds, bytes, process.execPath, '-e', source],
    {
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

test('keeps successful output and child exit status', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-phase-'));
  try {
    const logPath = path.join(directory, 'phase.log');
    const result = run(logPath, 5, 256, "process.stdout.write('ok\\n')");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'ok\n');
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'ok\n');
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
    const metrics = JSON.parse(fs.readFileSync(`${logPath}.metrics.json`, 'utf8'));
    assert.equal(metrics.schema_version, 1);
    assert.equal(metrics.exit_code, 0);
    assert.equal(metrics.output_bytes, 3);
    assert.ok(metrics.wall_seconds >= 0);
    assert.equal(fs.statSync(`${logPath}.metrics.json`).mode & 0o777, 0o600);
    const failedLog = path.join(directory, 'failed.log');
    assert.equal(run(failedLog, 5, 256, 'process.exit(17)').status, 17);
    assert.equal(JSON.parse(fs.readFileSync(`${failedLog}.metrics.json`, 'utf8')).exit_code, 17);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects oversized output without retaining excess bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-phase-'));
  try {
    const logPath = path.join(directory, 'phase.log');
    const result = run(logPath, 5, 64, "process.stdout.write('x'.repeat(4096))");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /retained-output limit/);
    assert.ok(fs.statSync(logPath).size <= 64);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stops an idle child at its phase deadline', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-phase-'));
  try {
    const result = run(path.join(directory, 'phase.log'), 1, 256, 'setInterval(() => {}, 1000)');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /time limit/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stops descendants that inherit output pipes after their parent exits', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-phase-'));
  try {
    const source =
      "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });";
    const result = run(path.join(directory, 'phase.log'), 1, 256, source);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /time limit/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('refuses to replace a pre-existing log', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-phase-'));
  try {
    const logPath = path.join(directory, 'phase.log');
    fs.writeFileSync(logPath, 'preserved');
    const result = run(logPath, 5, 256, "process.stdout.write('replacement')");
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'preserved');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
