import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const runtime = process.argv[2];
const database = process.env.RUNTIME_ACCEPTANCE_DATABASE_URL;
if (
  process.argv.length !== 3 ||
  !runtime ||
  !path.isAbsolute(runtime) ||
  process.platform !== 'linux' ||
  process.arch !== 'arm64' ||
  process.getuid() !== 0 ||
  process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST !== '1' ||
  database !==
    'postgresql://umami:mac-release-test-password-0000000000000000@127.0.0.1:5432/umami?schema=public'
) {
  throw new Error('Packaged recovery acceptance requires the disposable ARM64 fixture.');
}

const administrator = '41e2b680-648e-4b09-bcd7-3e2b10c06264';
const syntheticSecret = 'synthetic-packaged-recovery-acceptance-000000000000';
const nodeRoot = path.dirname(path.dirname(await fs.realpath(process.execPath)));

function query(sql) {
  return execFileSync(
    '/usr/lib/postgresql/17/bin/psql',
    [
      '-X',
      '-h',
      '127.0.0.1',
      '-p',
      '5432',
      '-U',
      'umami',
      '-d',
      'umami',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin' } },
  ).trim();
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function credentialDigests() {
  return query(
    `SELECT code_digest FROM login_recovery_credential WHERE user_id = '${administrator}' ORDER BY code_digest`,
  )
    .split('\n')
    .filter(Boolean);
}

function ownerFingerprint() {
  return digest(
    query(`SELECT row_to_json(owner) FROM "user" owner WHERE user_id = '${administrator}'`),
  );
}

function issue({ confirmation = 'admin', userId = administrator, uid = 501, tty = true } = {}) {
  const argumentsList = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--uid',
    String(uid),
    '--gid',
    '20',
    '--clearenv',
    '--ro-bind',
    runtime,
    '/app',
    '--ro-bind',
    nodeRoot,
    '/runtime-node',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind-try',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--chdir',
    '/app',
  ];
  for (const [name, value] of Object.entries({
    PATH: '/runtime-node/bin:/usr/bin:/bin',
    HOME: '/tmp',
    NODE_ENV: 'production',
    DATABASE_URL: database,
    APP_SECRET: syntheticSecret,
  }))
    argumentsList.push('--setenv', name, value);
  argumentsList.push(
    '/runtime-node/bin/node',
    '/app/runtime-scripts/issue-login-recovery.mjs',
    '--user-id',
    userId,
  );
  const command = ['bwrap', ...argumentsList]
    .map(value => `'${value.replaceAll("'", "'\\''")}'`)
    .join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn(
      tty ? '/usr/bin/script' : 'bwrap',
      tty ? ['-qefc', command, '/dev/null'] : argumentsList,
      {
        env: { PATH: '/usr/bin:/bin', TERM: 'dumb' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let error = '';
    let overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 32768) {
        overflow = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', chunk => {
      error += chunk;
      if (error.length > 8192) {
        overflow = true;
        child.kill('SIGKILL');
      }
    });
    child.stdin.on('error', () => undefined);
    child.once('error', failure => {
      clearTimeout(timer);
      reject(failure);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (overflow) return reject(new Error('Packaged recovery fixture exceeded output bounds.'));
      resolve({ code, output, error });
    });
    child.stdin.end(`${confirmation}\n`);
  });
}

function issuedCodes(result) {
  assert.equal(result.code, 0, 'The unpacked recovery tool must issue successfully.');
  assert.equal(result.error, '', 'Successful fixture issuance must not log errors.');
  const codes = result.output.match(/UR-[0-9A-F]{64}/g) ?? [];
  assert.equal(codes.length, 8, 'The unpacked tool must return eight synthetic codes.');
  assert.equal(new Set(codes).size, 8);
  const expected = codes.map(code => digest(`umami-login-recovery:v1\0${code}`)).sort();
  assert.deepEqual(credentialDigests(), expected, 'Only code digests may persist.');
  return expected;
}

const originalRequired = query(
  `SELECT two_factor_required FROM "user" WHERE user_id = '${administrator}'`,
);
assert.ok(['t', 'f'].includes(originalRequired), 'The fixture administrator must exist.');
query(`UPDATE "user" SET two_factor_required = true WHERE user_id = '${administrator}'`);
const before = ownerFingerprint();
try {
  const initial = issuedCodes(await issue());
  assert.equal(
    ownerFingerprint(),
    before,
    'Issuance must preserve the owner, password and required factors.',
  );
  for (const options of [
    { confirmation: 'unconfirmed' },
    { userId: '11111111-1111-4111-8111-111111111111' },
    { uid: 0 },
    { tty: false },
  ]) {
    const rejected = await issue(options);
    assert.notEqual(rejected.code, 0, 'The protected issuance precondition must fail closed.');
    assert.doesNotMatch(rejected.output + rejected.error, /UR-[0-9A-F]{64}/);
    assert.match(rejected.output + rejected.error, /Recovery issuance did not complete/);
    assert.deepEqual(
      credentialDigests(),
      initial,
      'Rejected issuance must preserve existing credentials.',
    );
  }
  const replacement = issuedCodes(await issue());
  assert.ok(
    replacement.every(value => !initial.includes(value)),
    'Lost or interrupted delivery must be replaceable.',
  );
  assert.equal(ownerFingerprint(), before, 'Replacement must preserve the owner security state.');
  process.stdout.write(
    'Unpacked non-root TTY recovery issuance, replacement, authorization and factor preservation passed using synthetic owners only.\n',
  );
} finally {
  query(`DELETE FROM login_recovery_credential WHERE user_id = '${administrator}'`);
  query(
    `UPDATE "user" SET two_factor_required = ${originalRequired === 't'} WHERE user_id = '${administrator}'`,
  );
}
