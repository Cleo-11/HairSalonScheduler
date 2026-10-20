import { migrate } from '../src/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const reset = process.argv.includes('--reset');
if (reset && process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
await migrate(url, { reset, log: console.log });
console.log('Migrations up to date');
