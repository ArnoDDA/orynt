import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createEmptyProductState, normalizeProductState, productCollections } from '../../../packages/domain/src/product-model.js';

const parse = (value, fallback, onCorrupt) => {
  try { return value == null ? fallback : JSON.parse(value); }
  catch (error) { onCorrupt?.(error); return fallback; }
};

export class Repository {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS local_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS product_entities (
        collection_name TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(collection_name, entity_id)
      );
      CREATE INDEX IF NOT EXISTS product_entities_workspace ON product_entities(workspace_id, collection_name);
      CREATE TABLE IF NOT EXISTS command_log (
        idempotency_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS corrupt_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        record_key TEXT,
        payload TEXT,
        detected_at TEXT NOT NULL
      );
    `);
    const storedSchemaRow = this.db.prepare("SELECT value FROM local_meta WHERE key='schemaVersion'").get();
    const storedSchemaVersion = parse(storedSchemaRow?.value, null);
    this.state = this.load();
    let recovered = false;
    for (const job of this.state.jobs) {
      if (job.status !== 'running') continue;
      job.status = 'queued'; job.recoveredAt = new Date().toISOString(); job.updatedAt = job.recoveredAt;
      for (const step of job.steps || []) if (step.status === 'running') step.status = 'queued';
      recovered = true;
    }
    if (recovered || !this.hasStructuredState() || storedSchemaVersion !== this.state.schemaVersion) this.persist(this.state);
  }

  hasStructuredState() {
    return Boolean(this.db.prepare("SELECT 1 AS present FROM local_meta WHERE key='workspace' LIMIT 1").get());
  }

  quarantine(source, key, payload) {
    this.db.prepare('INSERT INTO corrupt_records(source, record_key, payload, detected_at) VALUES (?, ?, ?, ?)')
      .run(source, key || null, String(payload ?? '').slice(0, 100_000), new Date().toISOString());
  }

  load() {
    if (!this.hasStructuredState()) {
      const legacy = this.db.prepare('SELECT payload FROM local_state WHERE id=1').get();
      if (!legacy) return createEmptyProductState();
      return normalizeProductState(parse(legacy.payload, createEmptyProductState(), () => this.quarantine('local_state', '1', legacy.payload)));
    }
    const empty = createEmptyProductState();
    const metaRows = this.db.prepare('SELECT key, value FROM local_meta').all();
    const meta = Object.fromEntries(metaRows.map(row => [row.key, parse(row.value, null, () => this.quarantine('local_meta', row.key, row.value))]));
    const state = { ...empty, schemaVersion: meta.schemaVersion || empty.schemaVersion, workspace: meta.workspace || empty.workspace, commands: {} };
    for (const row of this.db.prepare('SELECT collection_name, entity_id, payload FROM product_entities ORDER BY rowid').all()) {
      if (!productCollections.includes(row.collection_name)) continue;
      const entity = parse(row.payload, null, () => this.quarantine('product_entities', `${row.collection_name}:${row.entity_id}`, row.payload));
      if (entity) state[row.collection_name].push(entity);
    }
    for (const row of this.db.prepare('SELECT idempotency_key, payload FROM command_log').all()) {
      const command = parse(row.payload, null, () => this.quarantine('command_log', row.idempotency_key, row.payload));
      if (command) state.commands[row.idempotency_key] = command;
    }
    return normalizeProductState(state);
  }

  persist(state, previous = null) {
    const updatedAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.db.prepare('INSERT INTO product_entities(collection_name, entity_id, workspace_id, payload, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(collection_name, entity_id) DO UPDATE SET workspace_id=excluded.workspace_id, payload=excluded.payload, updated_at=excluded.updated_at');
      const remove = this.db.prepare('DELETE FROM product_entities WHERE collection_name=? AND entity_id=?');
      for (const collection of productCollections) {
        const old = new Map((previous?.[collection] || []).map(item => [item.id, JSON.stringify(item)]));
        for (const entity of state[collection]) {
          const payload = JSON.stringify(entity);
          if (old.get(entity.id) !== payload) upsert.run(collection, entity.id, entity.workspaceId || state.workspace.id, payload, entity.updatedAt || entity.createdAt || updatedAt);
          old.delete(entity.id);
        }
        for (const id of old.keys()) remove.run(collection, id);
      }
      const upsertCommand = this.db.prepare('INSERT INTO command_log(idempotency_key, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(idempotency_key) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at');
      const removeCommand = this.db.prepare('DELETE FROM command_log WHERE idempotency_key=?');
      const oldCommands = new Map(Object.entries(previous?.commands || {}).map(([key, command]) => [key, JSON.stringify(command)]));
      for (const [key, command] of Object.entries(state.commands)) {
        const payload = JSON.stringify(command);
        if (oldCommands.get(key) !== payload) upsertCommand.run(key, payload, command.createdAt || updatedAt);
        oldCommands.delete(key);
      }
      for (const key of oldCommands.keys()) removeCommand.run(key);
      if (!previous || previous.schemaVersion !== state.schemaVersion) this.db.prepare("INSERT INTO local_meta(key, value) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(state.schemaVersion));
      if (!previous || JSON.stringify(previous.workspace) !== JSON.stringify(state.workspace)) this.db.prepare("INSERT INTO local_meta(key, value) VALUES ('workspace', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(state.workspace));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  transact(fn) {
    const next = structuredClone(this.state);
    const result = fn(next);
    this.persist(next, this.state);
    this.state = next;
    return structuredClone(result ?? null);
  }
  read() { return structuredClone(this.state); }
  close() { this.db.close(); }
}
