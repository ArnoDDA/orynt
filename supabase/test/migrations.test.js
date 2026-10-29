import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationUrl = new URL('../migrations/0003_full_p0_alignment.sql', import.meta.url);
const sql = readFileSync(fileURLToPath(migrationUrl), 'utf8')
  .replace(/\s+/g, ' ')
  .toLowerCase();

function includesAll(...fragments) {
  for (const fragment of fragments) {
    assert.ok(sql.includes(fragment.toLowerCase()), `missing SQL contract: ${fragment}`);
  }
}

test('campaign stage and lifecycle are stored separately', () => {
  includesAll(
    'alter type public.campaign_status rename to campaign_stage',
    'alter table public.campaigns rename column status to stage',
    "campaign_lifecycle_status as enum ('active', 'blocked', 'archived', 'deleted')",
    'add column selected_card_version_id uuid',
    'add column inherited_learning_id uuid'
  );
});

test('all P0 domain boundaries have first-class tables', () => {
  for (const table of [
    'brand_memory_entries', 'brand_assets', 'discovery_sources', 'signal_feedback',
    'card_sets', 'card_evidence', 'card_feedback', 'generation_requests',
    'launch_plan_assets', 'provider_connections', 'idempotency_keys'
  ]) {
    assert.match(sql, new RegExp(`create table public\\.${table} \\(`));
    assert.ok(sql.includes(`'${table}'`), `${table} is missing from the RLS table list`);
  }
  includesAll("execute format('alter table public.%i enable row level security', t)");
});

test('generation provenance is explicit and constrained', () => {
  includesAll(
    'alter column creative_angle_id set not null',
    'generation_configs_angle_version_key unique (creative_angle_id, version)',
    'source_card_version_id uuid not null',
    'generation_request_id uuid',
    'alter column generation_request_id set not null',
    'assets_generation_request_key unique (generation_request_id)',
    'create trigger generation_requests_validate_lineage',
    'create trigger assets_validate_lineage',
    'create trigger assets_protect_provenance'
  );
});

test('launch and learning data keep explicit lineage and quality metadata', () => {
  includesAll(
    'create table public.launch_plan_assets',
    'add column external_campaign_id text',
    'add column external_ad_set_id text',
    'add column match_method text',
    'add column synced_at timestamptz',
    'add column quality_json jsonb',
    'add column adopted_at timestamptz',
    'create trigger metric_snapshots_immutable'
  );
});

test('job claiming follows position and completed dependencies', () => {
  includesAll(
    'add column position integer',
    'add column depends_on_step_id uuid',
    'dependency.status = \'succeeded\'',
    'order by j.created_at, st.position',
    "st.status = 'running' and st.lease_expires_at <= now()",
    'st.attempt_count < st.max_attempts',
    'create trigger job_steps_validate_dependency'
  );

  const replacement = sql.slice(sql.lastIndexOf('create or replace function public.claim_job_step'));
  assert.ok(!replacement.includes('order by j.created_at,st.step_key'));
});

test('version records and audit-grade facts are immutable', () => {
  includesAll(
    'card_versions_immutable before update or delete',
    'generation_configs_immutable before update or delete',
    'campaign_briefs_immutable before update or delete',
    'metric_snapshots_immutable before update or delete'
  );
});
