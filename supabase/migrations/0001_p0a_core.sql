create extension if not exists pgcrypto;

create type public.member_role as enum ('owner', 'editor', 'viewer');
create type public.campaign_status as enum ('draft', 'discovering', 'cards_ready', 'creating', 'launch_ready', 'learning', 'closed');
create type public.card_status as enum ('candidate', 'reviewed', 'adopted', 'dismissed', 'superseded');
create type public.asset_status as enum ('draft', 'generating', 'ready', 'partial_failed', 'failed', 'launch_ready', 'archived');
create type public.job_status as enum ('queued', 'running', 'succeeded', 'partial_failed', 'failed', 'cancelled');
create type public.job_step_status as enum ('queued', 'running', 'succeeded', 'partial_failed', 'failed', 'cancelled');

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace_id and user_id = auth.uid()
  );
$$;

create or replace function public.has_workspace_role(target_workspace_id uuid, allowed public.member_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace_id
      and user_id = auth.uid()
      and role = any(allowed)
  );
$$;

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  website_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, website_url)
);

create table public.brand_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete restrict,
  version integer not null check (version > 0),
  source text not null default 'user_and_provider',
  frozen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (brand_id, version)
);

create table public.brand_facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_snapshot_id uuid not null references public.brand_snapshots(id) on delete cascade,
  field_key text not null,
  value jsonb not null,
  source_url text,
  confidence numeric(3,2) check (confidence between 0 and 1),
  confirmation_status text not null check (confirmation_status in ('candidate', 'confirmed', 'corrected', 'skipped')),
  created_at timestamptz not null default now()
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete restrict,
  brand_snapshot_id uuid not null references public.brand_snapshots(id) on delete restrict,
  name text not null,
  objective text not null,
  status public.campaign_status not null default 'draft',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.campaign_briefs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  version integer not null check (version > 0),
  intent jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (campaign_id, version)
);

create table public.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  brand_snapshot_id uuid not null references public.brand_snapshots(id) on delete restrict,
  brief_id uuid not null references public.campaign_briefs(id) on delete restrict,
  status public.job_status not null default 'queued',
  coverage jsonb not null default '{}'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  discovery_run_id uuid not null references public.discovery_runs(id) on delete cascade,
  source_url text not null,
  observed_at timestamptz,
  ingested_at timestamptz not null default now(),
  source_type text not null,
  raw_evidence_ref text not null,
  content_summary text not null,
  created_at timestamptz not null default now()
);

create table public.market_signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  discovery_run_id uuid not null references public.discovery_runs(id) on delete cascade,
  evidence_id uuid references public.evidence(id) on delete set null,
  signal_type text not null,
  relevance_basis text not null,
  coverage jsonb not null default '{}'::jsonb,
  status text not null default 'available' check (status in ('available', 'weak', 'failed')),
  created_at timestamptz not null default now()
);

create table public.campaign_cards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  status public.card_status not null default 'candidate',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.card_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  card_id uuid not null references public.campaign_cards(id) on delete cascade,
  discovery_run_id uuid not null references public.discovery_runs(id) on delete restrict,
  version integer not null check (version > 0),
  opportunity text not null,
  audience text not null,
  claim text not null,
  creative_route jsonb not null,
  test_hypothesis text not null,
  applicability jsonb not null,
  facts jsonb not null,
  inferences jsonb not null,
  assumptions_to_test jsonb not null,
  risks_and_boundaries jsonb not null,
  quality_status text not null check (quality_status in ('passed', 'rejected', 'partial')),
  created_at timestamptz not null default now(),
  unique (card_id, version)
);

create table public.creative_packages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  card_id uuid not null references public.campaign_cards(id) on delete restrict,
  card_version_id uuid not null references public.card_versions(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (card_version_id)
);

create table public.creative_angles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  package_id uuid not null references public.creative_packages(id) on delete cascade,
  position integer not null check (position > 0),
  hook text not null,
  proof text not null,
  visual_language text not null,
  created_at timestamptz not null default now(),
  unique (package_id, position)
);

create table public.generation_configs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  package_id uuid not null references public.creative_packages(id) on delete cascade,
  version integer not null check (version > 0),
  config jsonb not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (package_id, version)
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  package_id uuid not null references public.creative_packages(id) on delete restrict,
  creative_angle_id uuid references public.creative_angles(id) on delete restrict,
  card_version_id uuid not null references public.card_versions(id) on delete restrict,
  generation_config_id uuid not null references public.generation_configs(id) on delete restrict,
  version integer not null check (version > 0),
  status public.asset_status not null default 'draft',
  storage_ref text,
  safety jsonb not null default '{"status":"unknown"}'::jsonb,
  created_at timestamptz not null default now(),
  unique (package_id, version)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  job_type text not null,
  status public.job_status not null default 'queued',
  idempotency_key text not null,
  request_hash text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create table public.job_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  step_key text not null,
  status public.job_step_status not null default 'queued',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  input_snapshot_ref text,
  output_snapshot_ref text,
  provider_call_id uuid,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_message_safe text,
  unique (job_id, step_key)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid references auth.users(id),
  action text not null,
  resource_type text not null,
  resource_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index campaigns_workspace_updated_idx on public.campaigns (workspace_id, updated_at desc);
create index cards_campaign_idx on public.campaign_cards (campaign_id, created_at desc);
create index assets_campaign_idx on public.assets (campaign_id, created_at desc);
create index jobs_workspace_status_idx on public.jobs (workspace_id, status, updated_at desc);
create index job_steps_lease_idx on public.job_steps (status, lease_expires_at);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.brands enable row level security;
alter table public.brand_snapshots enable row level security;
alter table public.brand_facts enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_briefs enable row level security;
alter table public.discovery_runs enable row level security;
alter table public.evidence enable row level security;
alter table public.market_signals enable row level security;
alter table public.campaign_cards enable row level security;
alter table public.card_versions enable row level security;
alter table public.creative_packages enable row level security;
alter table public.creative_angles enable row level security;
alter table public.generation_configs enable row level security;
alter table public.assets enable row level security;
alter table public.jobs enable row level security;
alter table public.job_steps enable row level security;
alter table public.audit_events enable row level security;

create policy "read member workspaces" on public.workspaces for select using (public.is_workspace_member(id));
create policy "read own memberships" on public.workspace_members for select using (user_id = auth.uid());

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'brands', 'brand_snapshots', 'brand_facts', 'campaigns', 'campaign_briefs', 'discovery_runs',
    'evidence', 'market_signals', 'campaign_cards', 'card_versions', 'creative_packages',
    'creative_angles', 'generation_configs', 'assets', 'jobs', 'job_steps', 'audit_events'
  ] loop
    execute format('create policy "read workspace data" on public.%I for select using (public.is_workspace_member(workspace_id))', table_name);
    -- Domain writes are performed by the authenticated Core API only.
    -- Browser clients, including Editors, cannot directly alter state or audit records.
  end loop;
end $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create trigger touch_workspaces before update on public.workspaces for each row execute function public.touch_updated_at();
create trigger touch_brands before update on public.brands for each row execute function public.touch_updated_at();
create trigger touch_campaigns before update on public.campaigns for each row execute function public.touch_updated_at();
create trigger touch_cards before update on public.campaign_cards for each row execute function public.touch_updated_at();
create trigger touch_jobs before update on public.jobs for each row execute function public.touch_updated_at();
