import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/db.js';
import { DevMessenger } from '../../src/messaging/dev.js';
import { TEST_DATABASE_URL } from '../global-setup.js';
import { rawSpec, testConfig } from '../helpers.js';

const toSpecPath = (url: string) => url.replace(/:([A-Za-z_]+)/g, '{$1}');

describe('openapi.yaml', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const api = await SwaggerParser.validate(structuredClone(rawSpec));
    expect((api as { openapi?: string }).openapi).toBe('3.1.0');
  });

  it('documents exactly the routes the server has', async () => {
    const db = createPool(TEST_DATABASE_URL);
    const m = new DevMessenger(() => {});
    const { app, routes } = await buildApp({ config: testConfig(), db, messaging: { otp: m, notifier: m } });
    await app.ready();
    await app.close();
    await db.end();

    const server = new Set(routes.map((r) => `${r.method} ${toSpecPath(r.url)}`));
    const spec = new Set<string>();
    for (const [p, item] of Object.entries(rawSpec.paths as Record<string, Record<string, unknown>>)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) if (item[method]) spec.add(`${method.toUpperCase()} ${p}`);
    }
    expect([...server].filter((r) => !spec.has(r)), 'routes missing from openapi.yaml').toEqual([]);
    expect([...spec].filter((r) => !server.has(r)), 'documented routes the server lacks').toEqual([]);
  });

  it('every operation has an operationId and documents a 2xx response', () => {
    const ids = new Set<string>();
    for (const item of Object.values(rawSpec.paths as Record<string, Record<string, any>>)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        const op = item[method];
        if (!op) continue;
        expect(op.operationId).toBeTruthy();
        expect(ids.has(op.operationId)).toBe(false);
        ids.add(op.operationId);
        expect(Object.keys(op.responses).some((c) => c.startsWith('2'))).toBe(true);
      }
    }
  });
});
