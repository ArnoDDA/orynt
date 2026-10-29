-- Complete the P0 product model without rewriting the migration history.
-- Existing rows are backfilled before the stricter lineage constraints are enabled.

-- Campaign progression and lifecycle are independent concepts.
alter type public.campaign_status rename to campaign_stage;
alter table public.campaigns rename column status to stage;
create type public.campaign_lifecycle_status as enum ('active', 'blocked', 'archived', 'deleted');
alter table public.campaigns
  add column status public.campaign_lifecycle_status not null default 'active',
  add column selected_card_version_id uuid,
  add column inherited_learning_id uuid;
update public.campaigns set status = 'archived' where stage = 'closed';

-- Temporarily remove version guards while legacy rows receive additive metadata.
drop trigger card_versions_immutable on public.card_versions;
drop trigger generation_configs_immutable on public.generation_configs;

-- Persistent brand context and reusable brand-owned inputs.
create table public.brand_memory_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null,
  memory_type text not null,
  content jsonb not null,
  source_type text not null default 'user_confirmed',
  confidence numeric(3,2) check (confidence between 0 and 1),
  status text not null default 'active' check (status in ('active', 'superseded', 'deleted')),
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, brand_id) references public.brands(workspace_id, id)
);

create table public.brand_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  brand_id uuid not null,
  asset_type text not null check (asset_type in ('logo', 'product_image', 'reference_image', 'font', 'other')),
  storage_ref text not null,
  filename text,
  mime_type text,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'archived', 'deleted')),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, brand_id) references public.brands(workspace_id, id)
);

alter table public.brand_snapshots
  add column source_campaign_id uuid,
  add column confirmation_status text not null default 'pending'
    check (confirmation_status in ('pending', 'confirmed', 'skipped')),
  add column snapshot_data jsonb not null default '{}'::jsonb,
  add column asset_manifest jsonb not null default '[]'::jsonb,
  add constraint brand_snapshots_source_campaign_workspace_fk
    foreign key (workspace_id, source_campaign_id) references public.campaigns(workspace_id, id);

-- Discovery keeps source records distinct from evidence extracted from those sources.
create table public.discovery_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  discovery_run_id uuid not null,
  source_type text not null,
  provider text,
  source_url text,
  external_source_id text,
  status text not null default 'pending'
    check (status in ('pending', 'available', 'coverage_insufficient', 'failed')),
  coverage jsonb not null default '{}'::jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, discovery_run_id) references public.discovery_runs(workspace_id, id)
);

alter table public.evidence add column discovery_source_id uuid;
alter table public.evidence
  add constraint evidence_source_workspace_fk
  foreign key (workspace_id, discovery_source_id) references public.discovery_sources(workspace_id, id);

create table public.signal_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  signal_id uuid not null,
  feedback_type text not null check (feedback_type in ('useful', 'not_useful', 'incorrect', 'saved')),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, signal_id) references public.market_signals(workspace_id, id)
);

-- A card set is the versioned output boundary of one discovery/card-generation run.
create table public.card_sets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null,
  discovery_run_id uuid not null,
  brief_id uuid not null,
  generation_job_id uuid,
  version integer not null check (version > 0),
  status text not null default 'draft'
    check (status in ('draft', 'partial_published', 'published', 'superseded')),
  quality_report jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (workspace_id, id),
  unique (campaign_id, version),
  unique (workspace_id, campaign_id, id),
  foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id),
  foreign key (workspace_id, discovery_run_id) references public.discovery_runs(workspace_id, id),
  foreign key (workspace_id, brief_id) references public.campaign_briefs(workspace_id, id),
  foreign key (workspace_id, generation_job_id) references public.jobs(workspace_id, id)
);

alter table public.campaign_cards
  add column card_set_id uuid,
  add column adopted_version_id uuid,
  add column saved boolean not null default false,
  add constraint campaign_cards_campaign_identity unique (workspace_id, campaign_id, id),
  add constraint campaign_cards_card_set_campaign_fk
    foreign key (workspace_id, campaign_id, card_set_id)
    references public.card_sets(workspace_id, campaign_id, id);

-- Preserve legacy cards by grouping them into one synthetic set per campaign/run.
insert into public.card_sets (
  workspace_id, campaign_id, discovery_run_id, brief_id, version, status, published_at
)
select
  c.workspace_id, c.campaign_id, v.discovery_run_id, d.brief_id,
  row_number() over (partition by c.campaign_id order by min(c.created_at), v.discovery_run_id)::integer,
  'published', now()
from public.campaign_cards c
join public.card_versions v on v.card_id = c.id and v.workspace_id = c.workspace_id
join public.discovery_runs d on d.id = v.discovery_run_id and d.workspace_id = v.workspace_id
where c.card_set_id is null
group by c.workspace_id, c.campaign_id, v.discovery_run_id, d.brief_id;

with card_origins as (
  select distinct on (cv.workspace_id, cv.card_id)
    cv.workspace_id, cv.card_id, cv.discovery_run_id
  from public.card_versions cv
  order by cv.workspace_id, cv.card_id, cv.version
)
update public.campaign_cards c
set card_set_id = s.id
from card_origins origin
join public.card_sets s
  on s.workspace_id = origin.workspace_id and s.discovery_run_id = origin.discovery_run_id
where c.card_set_id is null
  and origin.workspace_id = c.workspace_id and origin.card_id = c.id
  and s.campaign_id = c.campaign_id;

alter table public.campaign_cards alter column card_set_id set not null;

alter table public.card_versions
  add column publication_status text not null default 'published'
    check (publication_status in ('draft', 'published', 'superseded')),
  add column quality_report jsonb not null default '{}'::jsonb,
  add column published_at timestamptz,
  add constraint card_versions_card_identity unique (workspace_id, card_id, id);
update public.card_versions set published_at = created_at where published_at is null and publication_status = 'published';

with latest_versions as (
  select distinct on (workspace_id, card_id) workspace_id, card_id, id
  from public.card_versions
  order by workspace_id, card_id, version desc
)
update public.campaign_cards c
set adopted_version_id = v.id
from latest_versions v
where v.workspace_id = c.workspace_id and v.card_id = c.id
  and c.status = 'adopted' and c.adopted_version_id is null;

alter table public.campaign_cards
  add constraint campaign_cards_adopted_version_fk
  foreign key (workspace_id, id, adopted_version_id)
  references public.card_versions(workspace_id, card_id, id);

create table public.card_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  card_version_id uuid not null,
  evidence_id uuid not null,
  relationship text not null check (relationship in ('supports', 'contradicts', 'context')),
  note text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (card_version_id, evidence_id, relationship),
  foreign key (workspace_id, card_version_id) references public.card_versions(workspace_id, id),
  foreign key (workspace_id, evidence_id) references public.evidence(workspace_id, id)
);

create table public.card_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  card_id uuid not null,
  card_version_id uuid not null,
  feedback_type text not null check (feedback_type in ('adopt', 'dismiss', 'save', 'unsave')),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, card_id, card_version_id)
    references public.card_versions(workspace_id, card_id, id)
);

-- Campaign selections are validated against the actual card lineage.
create function public.check_campaign_card_selection()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.selected_card_version_id is not null and not exists (
    select 1 from public.card_versions cv
    join public.campaign_cards c on c.id = cv.card_id and c.workspace_id = cv.workspace_id
    where cv.id = new.selected_card_version_id
      and cv.workspace_id = new.workspace_id
      and c.campaign_id = new.id
  ) then
    raise exception 'Selected Card Version must belong to the Campaign';
  end if;
  return new;
end $$;
create trigger campaigns_validate_selected_card
before insert or update of selected_card_version_id on public.campaigns
for each row execute function public.check_campaign_card_selection();

alter table public.campaigns
  add constraint campaigns_selected_card_version_workspace_fk
    foreign key (workspace_id, selected_card_version_id) references public.card_versions(workspace_id, id),
  add constraint campaigns_inherited_learning_workspace_fk
    foreign key (workspace_id, inherited_learning_id) references public.learning_conclusions(workspace_id, id);

-- Configs are frozen per creative angle, not merely per package.
alter table public.creative_angles
  add column name text,
  add column status text not null default 'active' check (status in ('active', 'archived')),
  add constraint creative_angles_package_identity unique (workspace_id, package_id, id);

insert into public.creative_angles (workspace_id, package_id, position, name, hook, proof, visual_language)
select p.workspace_id, p.id, 1, '迁移保留角度', '保留原配置', '保留原配置', 'legacy'
from public.creative_packages p
where (exists (select 1 from public.generation_configs g where g.package_id = p.id)
    or exists (select 1 from public.assets a where a.package_id = p.id))
  and not exists (select 1 from public.creative_angles a where a.package_id = p.id);

alter table public.generation_configs
  add column creative_angle_id uuid,
  add column campaign_id uuid,
  add column card_version_id uuid,
  add column status text not null default 'frozen' check (status in ('draft', 'frozen', 'superseded'));

update public.generation_configs g
set creative_angle_id = a.id,
    campaign_id = p.campaign_id,
    card_version_id = p.card_version_id
from public.creative_packages p
join lateral (
  select ca.id from public.creative_angles ca
  where ca.package_id = p.id and ca.workspace_id = p.workspace_id
  order by ca.position limit 1
) a on true
where p.id = g.package_id and p.workspace_id = g.workspace_id;

alter table public.generation_configs
  alter column creative_angle_id set not null,
  alter column campaign_id set not null,
  alter column card_version_id set not null,
  drop constraint generation_configs_package_id_version_key,
  add constraint generation_configs_angle_version_key unique (creative_angle_id, version),
  add constraint generation_configs_angle_package_fk
    foreign key (workspace_id, package_id, creative_angle_id)
    references public.creative_angles(workspace_id, package_id, id),
  add constraint generation_configs_campaign_workspace_fk
    foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id),
  add constraint generation_configs_card_version_workspace_fk
    foreign key (workspace_id, card_version_id) references public.card_versions(workspace_id, id);

create function public.check_generation_config_lineage()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (
    select 1 from public.creative_packages p
    join public.creative_angles a
      on a.package_id = p.id and a.workspace_id = p.workspace_id
    where p.id = new.package_id and p.workspace_id = new.workspace_id
      and p.campaign_id = new.campaign_id
      and p.card_version_id = new.card_version_id
      and a.id = new.creative_angle_id
  ) then
    raise exception 'Generation Config lineage does not match its Package, Angle and Card Version';
  end if;
  return new;
end $$;
create trigger generation_configs_validate_lineage
before insert or update on public.generation_configs
for each row execute function public.check_generation_config_lineage();

create trigger card_versions_immutable before update or delete on public.card_versions
for each row execute function public.reject_version_mutation();
create trigger generation_configs_immutable before update or delete on public.generation_configs
for each row execute function public.reject_version_mutation();
drop trigger campaign_briefs_immutable on public.campaign_briefs;
create trigger campaign_briefs_immutable before update or delete on public.campaign_briefs
for each row execute function public.reject_version_mutation();

create type public.generation_request_status as enum ('queued', 'running', 'succeeded', 'partial_failed', 'failed', 'cancelled');
create table public.generation_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null,
  package_id uuid not null,
  creative_angle_id uuid not null,
  generation_config_id uuid not null,
  source_card_version_id uuid not null,
  job_id uuid,
  mode text not null check (mode in ('storyboard', 'video', 'image')),
  provider text not null,
  status public.generation_request_status not null default 'queued',
  safety_status text not null default 'pending',
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id),
  foreign key (workspace_id, package_id, creative_angle_id)
    references public.creative_angles(workspace_id, package_id, id),
  foreign key (workspace_id, generation_config_id) references public.generation_configs(workspace_id, id),
  foreign key (workspace_id, source_card_version_id) references public.card_versions(workspace_id, id),
  foreign key (workspace_id, job_id) references public.jobs(workspace_id, id)
);

create function public.check_generation_request_lineage()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (
    select 1 from public.generation_configs g
    where g.id = new.generation_config_id and g.workspace_id = new.workspace_id
      and g.campaign_id = new.campaign_id
      and g.package_id = new.package_id
      and g.creative_angle_id = new.creative_angle_id
      and g.card_version_id = new.source_card_version_id
  ) then
    raise exception 'Generation Request must preserve its frozen Config lineage';
  end if;
  return new;
end $$;
create trigger generation_requests_validate_lineage
before insert or update on public.generation_requests
for each row execute function public.check_generation_request_lineage();

alter table public.assets rename column card_version_id to source_card_version_id;
alter table public.assets
  add column generation_request_id uuid,
  add column asset_type text not null default 'video' check (asset_type in ('storyboard', 'video', 'image')),
  add column mime_type text,
  add column filename text;

update public.assets a
set creative_angle_id = coalesce(a.creative_angle_id, g.creative_angle_id)
from public.generation_configs g
where g.id = a.generation_config_id and g.workspace_id = a.workspace_id;

insert into public.generation_requests (
  id, workspace_id, campaign_id, package_id, creative_angle_id,
  generation_config_id, source_card_version_id, mode, provider, status,
  safety_status, created_at, completed_at
)
select a.id, a.workspace_id, a.campaign_id, a.package_id, a.creative_angle_id,
  a.generation_config_id, a.source_card_version_id, a.asset_type, 'legacy',
  case
    when a.status in ('ready', 'launch_ready', 'archived') then 'succeeded'::public.generation_request_status
    when a.status = 'failed' then 'failed'::public.generation_request_status
    when a.status = 'partial_failed' then 'partial_failed'::public.generation_request_status
    when a.status = 'generating' then 'running'::public.generation_request_status
    else 'queued'::public.generation_request_status
  end,
  coalesce(a.safety->>'status', 'unknown'), a.created_at,
  case when a.status in ('ready', 'launch_ready', 'archived', 'failed', 'partial_failed') then a.created_at end
from public.assets a;

update public.assets set generation_request_id = id where generation_request_id is null;
alter table public.assets
  alter column creative_angle_id set not null,
  alter column generation_request_id set not null,
  drop constraint assets_package_id_version_key,
  add constraint assets_angle_type_version_key unique (creative_angle_id, asset_type, version),
  add constraint assets_generation_request_key unique (generation_request_id),
  add constraint assets_angle_package_fk
    foreign key (workspace_id, package_id, creative_angle_id)
    references public.creative_angles(workspace_id, package_id, id),
  add constraint assets_generation_request_workspace_fk
    foreign key (workspace_id, generation_request_id) references public.generation_requests(workspace_id, id);

create function public.check_asset_lineage()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (
    select 1 from public.generation_requests r
    where r.id = new.generation_request_id and r.workspace_id = new.workspace_id
      and r.campaign_id = new.campaign_id
      and r.package_id = new.package_id
      and r.creative_angle_id = new.creative_angle_id
      and r.generation_config_id = new.generation_config_id
      and r.source_card_version_id = new.source_card_version_id
  ) then
    raise exception 'Asset must preserve its Generation Request provenance';
  end if;
  return new;
end $$;
create trigger assets_validate_lineage before insert or update on public.assets
for each row execute function public.check_asset_lineage();

-- Launch plans explicitly own an ordered set of assets.
create table public.launch_plan_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  launch_plan_id uuid not null,
  asset_id uuid not null,
  position integer not null check (position > 0),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (launch_plan_id, asset_id),
  unique (launch_plan_id, position),
  foreign key (workspace_id, launch_plan_id) references public.launch_plans(workspace_id, id),
  foreign key (workspace_id, asset_id) references public.assets(workspace_id, id)
);

insert into public.launch_plan_assets (workspace_id, launch_plan_id, asset_id, position)
select workspace_id, launch_plan_id, asset_id,
  row_number() over (partition by launch_plan_id order by created_at, id)::integer
from public.ad_mappings
on conflict (launch_plan_id, asset_id) do nothing;

create function public.check_launch_plan_asset_lineage()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (
    select 1 from public.launch_plans p
    join public.assets a on a.workspace_id = p.workspace_id
    where p.id = new.launch_plan_id and p.workspace_id = new.workspace_id
      and a.id = new.asset_id
      and a.campaign_id = p.campaign_id
      and a.source_card_version_id = p.card_version_id
  ) then
    raise exception 'Launch Plan Asset must use the same Campaign and Card Version';
  end if;
  return new;
end $$;
create trigger launch_plan_assets_validate_lineage
before insert or update on public.launch_plan_assets
for each row execute function public.check_launch_plan_asset_lineage();

alter table public.ad_mappings
  add column provider text not null default 'manual',
  add column external_campaign_id text,
  add column external_ad_set_id text,
  add column match_method text not null default 'manual'
    check (match_method in ('manual', 'exact', 'heuristic', 'provider_import')),
  add column confirmed_at timestamptz;
update public.ad_mappings set confirmed_at = created_at where confirmation_status = 'confirmed';

create function public.check_ad_mapping_asset()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (
    select 1 from public.launch_plan_assets lpa
    where lpa.workspace_id = new.workspace_id
      and lpa.launch_plan_id = new.launch_plan_id
      and lpa.asset_id = new.asset_id
  ) then
    raise exception 'Ad Mapping Asset must belong to its Launch Plan';
  end if;
  return new;
end $$;
create trigger ad_mappings_validate_plan_asset
before insert or update on public.ad_mappings
for each row execute function public.check_ad_mapping_asset();

alter table public.metric_snapshots
  add column synced_at timestamptz not null default now(),
  add column quality_json jsonb not null default '{}'::jsonb;

alter table public.learning_conclusions
  add column quality_json jsonb not null default '{}'::jsonb,
  add column adopted_at timestamptz;
update public.learning_conclusions set adopted_at = created_at where status = 'adopted';

-- Provider credentials stay outside the database; only a secret reference is retained.
create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  connection_type text not null,
  status text not null default 'disconnected'
    check (status in ('disconnected', 'connected', 'degraded', 'revoked')),
  credential_ref text,
  scopes jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, provider, connection_type)
);
create trigger touch_provider_connections before update on public.provider_connections
for each row execute function public.touch_updated_at();

create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  idempotency_key text not null,
  action text not null,
  request_hash text not null,
  resource_type text,
  resource_id uuid,
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key)
);

-- Jobs identify their target and freeze the exact input versions used by execution.
alter table public.jobs
  add column resource_type text,
  add column resource_id uuid,
  add column attempt_count integer not null default 0 check (attempt_count >= 0),
  add column max_attempts integer not null default 3 check (max_attempts > 0),
  add column input_version_json jsonb not null default '{}'::jsonb,
  add column error_code text,
  add column available_at timestamptz not null default now();
update public.jobs
set resource_type = 'campaign', resource_id = campaign_id
where resource_type is null;
alter table public.jobs alter column resource_type set not null, alter column resource_id set not null;

alter table public.job_steps
  add column position integer,
  add column depends_on_step_id uuid;

with ranked as (
  select st.id,
    row_number() over (
      partition by st.job_id
      order by case
        when st.step_key in ('prepare_brand_context', 'freeze_inputs', 'validate_card_and_config') then 10
        when st.step_key in ('check_source_coverage', 'prepare_candidates', 'prepare_storyboard', 'check_video_provider') then 20
        when st.step_key in ('publish_discovery', 'validate_and_publish', 'save_preview') then 30
        else 100
      end, st.step_key, st.id
    )::integer as position
  from public.job_steps st
)
update public.job_steps st set position = ranked.position from ranked where ranked.id = st.id;

with ordered as (
  select id, lag(id) over (partition by job_id order by position) as previous_id
  from public.job_steps
)
update public.job_steps st set depends_on_step_id = ordered.previous_id
from ordered where ordered.id = st.id;

alter table public.job_steps
  alter column position set not null,
  add constraint job_steps_job_position_key unique (job_id, position),
  add constraint job_steps_dependency_not_self check (depends_on_step_id is null or depends_on_step_id <> id),
  add constraint job_steps_dependency_workspace_fk
    foreign key (workspace_id, depends_on_step_id) references public.job_steps(workspace_id, id);

create function public.check_job_step_dependency()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.depends_on_step_id is not null and not exists (
    select 1 from public.job_steps dependency
    where dependency.id = new.depends_on_step_id
      and dependency.workspace_id = new.workspace_id
      and dependency.job_id = new.job_id
      and dependency.position < new.position
  ) then
    raise exception 'Job Step dependency must be an earlier step in the same Job';
  end if;
  return new;
end $$;
create trigger job_steps_validate_dependency
before insert or update of job_id, position, depends_on_step_id on public.job_steps
for each row execute function public.check_job_step_dependency();

create index jobs_claimable_idx on public.jobs (workspace_id, status, available_at, created_at);
create index job_steps_order_idx on public.job_steps (job_id, position);
create index job_steps_dependency_idx on public.job_steps (depends_on_step_id) where depends_on_step_id is not null;
create index brand_memory_brand_idx on public.brand_memory_entries (brand_id, status, created_at desc);
create index brand_assets_brand_idx on public.brand_assets (brand_id, status, created_at desc);
create index generation_requests_campaign_idx on public.generation_requests (campaign_id, created_at desc);
create index discovery_sources_run_idx on public.discovery_sources (discovery_run_id, created_at);
create index signal_feedback_signal_idx on public.signal_feedback (signal_id, created_at desc);
create index card_sets_campaign_idx on public.card_sets (campaign_id, version desc);
create index card_evidence_version_idx on public.card_evidence (card_version_id, created_at);
create index card_feedback_card_idx on public.card_feedback (card_id, created_at desc);
create index launch_plan_assets_plan_idx on public.launch_plan_assets (launch_plan_id, position);
create index idempotency_keys_expiry_idx on public.idempotency_keys (expires_at) where expires_at is not null;

-- Immutable facts remain immutable; a ready Asset may change lifecycle status but not provenance.
create trigger metric_snapshots_immutable before update or delete on public.metric_snapshots
for each row execute function public.reject_version_mutation();

create function public.protect_asset_provenance()
returns trigger language plpgsql as $$
begin
  if old.status in ('ready', 'launch_ready', 'archived') and (
    new.workspace_id is distinct from old.workspace_id or
    new.campaign_id is distinct from old.campaign_id or
    new.package_id is distinct from old.package_id or
    new.creative_angle_id is distinct from old.creative_angle_id or
    new.source_card_version_id is distinct from old.source_card_version_id or
    new.generation_config_id is distinct from old.generation_config_id or
    new.generation_request_id is distinct from old.generation_request_id or
    new.asset_type is distinct from old.asset_type or
    new.version is distinct from old.version or
    new.storage_ref is distinct from old.storage_ref
  ) then
    raise exception 'Ready Asset provenance is immutable';
  end if;
  return new;
end $$;
create trigger assets_protect_provenance before update on public.assets
for each row execute function public.protect_asset_provenance();

-- New domain tables are readable by workspace members. Operational tables remain Core-API only.
do $$ declare t text; begin
  foreach t in array array[
    'brand_memory_entries', 'brand_assets', 'discovery_sources', 'signal_feedback',
    'card_sets', 'card_evidence', 'card_feedback', 'generation_requests',
    'launch_plan_assets', 'provider_connections', 'idempotency_keys'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array[
    'brand_memory_entries', 'brand_assets', 'discovery_sources', 'signal_feedback',
    'card_sets', 'card_evidence', 'card_feedback', 'generation_requests', 'launch_plan_assets'
  ] loop
    execute format(
      'create policy "read workspace data" on public.%I for select using(public.is_workspace_member(workspace_id))', t
    );
  end loop;
end $$;

-- Claim only the next dependency-safe step. Expired leases may be reclaimed within retry limits.
create or replace function public.claim_job_step(target_workspace uuid, worker_name text, allowed_types text[])
returns setof public.job_steps language plpgsql security definer set search_path = public as $$
declare target_id uuid; target_job_id uuid;
begin
  select st.id, st.job_id into target_id, target_job_id
  from public.job_steps st
  join public.jobs j on j.id = st.job_id and j.workspace_id = st.workspace_id
  left join public.job_steps dependency
    on dependency.id = st.depends_on_step_id and dependency.workspace_id = st.workspace_id
  where st.workspace_id = target_workspace
    and j.job_type = any(allowed_types)
    and j.status in ('queued', 'running')
    and (j.status = 'running' or j.attempt_count < j.max_attempts)
    and j.available_at <= now()
    and st.attempt_count < st.max_attempts
    and (
      (st.status = 'queued' and st.available_at <= now())
      or (st.status = 'running' and st.lease_expires_at <= now())
    )
    and (st.depends_on_step_id is null or dependency.status = 'succeeded')
  order by j.created_at, st.position
  for update of st skip locked
  limit 1;

  if target_id is null then return; end if;

  update public.jobs
  set status = 'running', attempt_count = attempt_count + case when status = 'queued' then 1 else 0 end
  where id = target_job_id;

  return query
  update public.job_steps
  set status = 'running', lease_id = gen_random_uuid(), lease_owner = worker_name,
      lease_expires_at = now() + interval '60 seconds', started_at = now(),
      finished_at = null, attempt_count = attempt_count + 1
  where id = target_id
  returning *;
end $$;
revoke all on function public.claim_job_step(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.claim_job_step(uuid, text, text[]) to service_role;
