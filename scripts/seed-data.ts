#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Umami Sample Data Generator
 *
 * Generates realistic analytics data for local development and testing.
 * Creates two demo websites:
 *   - Demo Blog: Low traffic (~100 sessions/month)
 *   - Demo SaaS: Average traffic (~500 sessions/day)
 *
 * Usage:
 *   NODE_ENV=development pnpm db:seed --allow-disposable-seed
 *   NODE_ENV=development pnpm db:seed --allow-disposable-seed --days 90
 *   NODE_ENV=development pnpm db:seed --allow-disposable-seed --clear --confirm-clear
 */

import { type SeedConfig, seed } from './seed/index.js';
import { MAX_SEED_DAYS, SeedSafetyError } from './seed/safety.js';

function parseDays(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw new SeedSafetyError(`--days must be an integer between 1 and ${MAX_SEED_DAYS}.`);
  }

  const days = Number(value);
  if (!Number.isSafeInteger(days) || days > MAX_SEED_DAYS) {
    throw new SeedSafetyError(`--days must be an integer between 1 and ${MAX_SEED_DAYS}.`);
  }

  return days;
}

function parseArgs(): SeedConfig {
  const args = process.argv.slice(2);

  const config: SeedConfig = {
    days: 30,
    clear: false,
    verbose: false,
    allowDisposableSeed: false,
    confirmClear: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--days') {
      config.days = parseDays(args[i + 1]);
      i++;
    } else if (arg === '--clear') {
      config.clear = true;
    } else if (arg === '--confirm-clear') {
      config.confirmClear = true;
    } else if (arg === '--allow-disposable-seed') {
      config.allowDisposableSeed = true;
    } else if (arg === '--verbose' || arg === '-v') {
      config.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--days=')) {
      config.days = parseDays(arg.slice('--days='.length));
    } else {
      throw new SeedSafetyError('Unknown seed option. Use --help for supported options.');
    }
  }

  return config;
}

function printHelp(): void {
  console.log(`
Umami Sample Data Generator

Generates realistic analytics data for local development and testing.

Usage:
  pnpm db:seed [options]

Options:
  --allow-disposable-seed   Explicitly opt in to a disposable local database
  --days <number>           Days of data to generate (1-${MAX_SEED_DAYS}, default: 30)
  --clear                   Clear existing seed-owned data first
  --confirm-clear           Required with --clear
  --verbose, -v             Show detailed progress
  --help, -h                Show this help message

Examples:
  NODE_ENV=development pnpm db:seed --allow-disposable-seed
  NODE_ENV=development pnpm db:seed --allow-disposable-seed --days 90
  NODE_ENV=development pnpm db:seed --allow-disposable-seed --clear --confirm-clear

Generated Sites:
  - Demo Blog:  Low traffic (~90 sessions/month)
  - Demo SaaS:  Average traffic (~500 sessions/day) with revenue tracking

Before use, create the disposable marker table in a dedicated local PostgreSQL
database. See docs/development-seed-safety.md. This command never accepts a
non-loopback database target or clears old name-matched demo websites.
`);
}

async function main(): Promise<void> {
  console.log('\nUmami Sample Data Generator\n');

  try {
    const config = parseArgs();
    await seed(config);
  } catch (error) {
    console.error(
      error instanceof SeedSafetyError
        ? `\nError: ${error.message}`
        : '\nError generating seed data.',
    );
    process.exit(1);
  }
}

main();
