import { migrate } from '../src/migrate.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://salon:salon@localhost:5432/salon_test';

export default async function setup() {
  // Fresh schema for every run.
  await migrate(TEST_DATABASE_URL, { reset: true });
}
