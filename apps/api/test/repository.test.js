import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/repository.js';
import { PRODUCT_SCHEMA_VERSION } from '../../../packages/domain/src/product-model.js';
import { Core } from '../src/core.js';

test('structured SQLite storage recovers running jobs after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orynt-recovery-'));
  const path = join(directory, 'workspace.sqlite');
  try {
    let repository = new Repository(path);
    let core = new Core(repository);
    const created = core.command('campaign.create', null, { brandUrl: 'https://restart.example' }, 'restart-create');
    const queued = core.command('discovery.start', created.campaignId, {}, 'restart-discovery');
    core.tick({ jobId: queued.jobId });
    assert.equal(repository.read().jobs[0].status, 'running');
    repository.close();

    repository = new Repository(path);
    const recovered = repository.read().jobs[0];
    assert.equal(recovered.status, 'queued');
    assert.ok(recovered.recoveredAt);
    const tables = repository.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    assert.ok(tables.includes('product_entities'));
    assert.ok(tables.includes('command_log'));
    repository.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('opening an older structured database persists the current schema version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orynt-schema-'));
  const path = join(directory, 'workspace.sqlite');
  try {
    let repository = new Repository(path);
    repository.db.prepare("UPDATE local_meta SET value='3' WHERE key='schemaVersion'").run();
    repository.close();
    repository = new Repository(path);
    assert.equal(repository.read().schemaVersion, PRODUCT_SCHEMA_VERSION);
    assert.equal(JSON.parse(repository.db.prepare("SELECT value FROM local_meta WHERE key='schemaVersion'").get().value), PRODUCT_SCHEMA_VERSION);
    repository.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a damaged entity is quarantined without taking down the workspace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orynt-corrupt-'));
  const path = join(directory, 'workspace.sqlite');
  try {
    let repository = new Repository(path);
    repository.transact(state => { state.brands.push({ id: 'brand-ok', workspaceId: 'local', name: 'OK' }); });
    repository.db.prepare("INSERT INTO product_entities(collection_name, entity_id, workspace_id, payload, updated_at) VALUES ('brands', 'brand-bad', 'local', '{bad json', '2026-09-17')").run();
    repository.close();
    repository = new Repository(path);
    assert.equal(repository.read().brands.some(item => item.id === 'brand-ok'), true);
    assert.equal(repository.read().brands.some(item => item.id === 'brand-bad'), false);
    assert.equal(repository.db.prepare('SELECT COUNT(*) AS count FROM corrupt_records').get().count, 1);
    repository.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unmodified entities are not rewritten while changed and deleted records persist', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orynt-delta-'));
  const path = join(directory, 'workspace.sqlite');
  try {
    let repository = new Repository(path);
    let core = new Core(repository);
    const first = core.command('campaign.create', null, { brandUrl: 'https://first.example' }, 'create-first');
    const second = core.command('campaign.create', null, { brandUrl: 'https://second.example' }, 'create-second');
    const before = repository.db.prepare("SELECT rowid, updated_at FROM product_entities WHERE collection_name='campaigns' AND entity_id=?").get(first.campaignId);
    core.command('campaign.archive', second.campaignId, {}, 'archive-second');
    const after = repository.db.prepare("SELECT rowid, updated_at FROM product_entities WHERE collection_name='campaigns' AND entity_id=?").get(first.campaignId);
    assert.deepEqual(after, before);
    const secondBrand = repository.read().campaigns.find(item => item.id === second.campaignId).brandId;
    repository.transact(state => { state.brands = state.brands.filter(item => item.id !== secondBrand); });
    assert.equal(repository.db.prepare("SELECT 1 FROM product_entities WHERE collection_name='brands' AND entity_id=?").get(secondBrand), undefined);
    repository.close();
    repository = new Repository(path); core = new Core(repository);
    assert.equal(repository.read().campaigns.find(item => item.id === second.campaignId).status, 'archived');
    assert.equal(core.command('campaign.create', null, { brandUrl: 'https://first.example' }, 'create-first').campaignId, first.campaignId);
    repository.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
