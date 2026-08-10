/**
 * HuduClient construction and resource wiring tests.
 */
import { describe, it, expect } from 'vitest';
import { HuduClient } from '../src/client.js';
import { HuduConfigError } from '../src/errors.js';
import { clearFetch, stubFetchAny } from './helpers.js';

const RESOURCES = [
  'companies', 'articles', 'assetLayouts', 'assetPasswords', 'assets', 'expirations',
  'exports', 'flagTypes', 'flags', 'folders', 'groups', 'ipAddresses', 'labelTypes',
  'labels', 'lists', 'magicDash', 'matchers', 'networks', 'passwordFolders', 'photos',
  'procedureTasks', 'procedures', 'publicPhotos', 'rackStorageItems', 'rackStorages',
  'relations', 's3Exports', 'uploads', 'users', 'vlanZones', 'vlans', 'websites',
  'apiInfo', 'activityLogs', 'cards',
] as const;

function makeClient() {
  return new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: 'key' });
}

describe('HuduClient', () => {
  beforeEach(() => stubFetchAny());
  afterEach(() => clearFetch());

  it('resolves and exposes the config', () => {
    const c = makeClient();
    expect(c.config.baseUrl).toBe('https://hudu.example.com');
    expect(c.config.basePath).toBe('/api/v1');
    expect(c.config.apiKey).toBe('key');
  });

  it('wires all 35 resource clients', () => {
    stubFetchAny();
    const c = makeClient();
    for (const name of RESOURCES) {
      const r = (c as unknown as Record<string, unknown>)[name];
      expect(r, `missing resource: ${name}`).toBeDefined();
    }
    expect(RESOURCES).toHaveLength(35);
  });

  it('throws HuduConfigError for an invalid baseUrl', () => {
    expect(() => new HuduClient({ baseUrl: 'ftp://bad', apiKey: 'k' })).toThrow(HuduConfigError);
  });

  it('throws HuduConfigError for a missing apiKey', () => {
    expect(() => new HuduClient({ baseUrl: 'https://hudu.example.com', apiKey: '' })).toThrow(HuduConfigError);
  });
});
