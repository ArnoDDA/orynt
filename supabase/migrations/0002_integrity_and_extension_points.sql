-- Lock down installations that applied the earlier development migration.
do $$ declare t text; begin
  foreach t in array array['brands','brand_snapshots','brand_facts','campaigns','campaign_briefs','discovery_runs','evidence','market_signals','campaign_cards','card_versions','creative_packages','creative_angles','generation_configs','assets','jobs','job_steps','audit_events'] loop
    execute format('drop policy if exists "write editor workspace data" on public.%I',t);
    execute format('alter table public.%I add constraint %I unique(workspace_id,id)',t,t||'_workspace_id_unique');
  end loop;
end $$;

create table public.provider_calls (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  job_step_id uuid not null, provider text not null, adapter_version text not null,
  input_version text not null, schema_version text not null, prompt_version text,
  external_request_id text, raw_ref text, error_code text, elapsed_ms integer,
  created_at timestamptz not null default now(), unique(workspace_id,id),
  foreign key(workspace_id,job_step_id) references public.job_steps(workspace_id,id)
);
alter table public.job_steps add constraint step_provider_call_fk foreign key(workspace_id,provider_call_id) references public.provider_calls(workspace_id,id);
alter table public.job_steps add column lease_id uuid;
alter table public.job_steps add column lease_owner text;
alter table public.job_steps add column available_at timestamptz not null default now();

create table public.launch_plans (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
  campaign_id uuid not null,card_version_id uuid not null,version integer not null check(version>0),
  status text not null default 'draft' check(status in ('draft','prepared','mapped','observing','completed')),
  channel text not null, audience text not null,test_hypothesis text not null,config jsonb not null default '{}',
  created_at timestamptz not null default now(),unique(workspace_id,id),unique(campaign_id,version),
  foreign key(workspace_id,campaign_id) references public.campaigns(workspace_id,id),
  foreign key(workspace_id,card_version_id) references public.card_versions(workspace_id,id)
);
create table public.ad_mappings (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
  launch_plan_id uuid not null,asset_id uuid not null,external_ad_id text not null,
  confirmation_status text not null check(confirmation_status in ('suggested','confirmed','rejected')),
  confidence numeric check(confidence between 0 and 1),created_at timestamptz not null default now(),unique(workspace_id,id),
  foreign key(workspace_id,launch_plan_id) references public.launch_plans(workspace_id,id),
  foreign key(workspace_id,asset_id) references public.assets(workspace_id,id),
  unique(launch_plan_id,asset_id,external_ad_id)
);
create table public.metric_snapshots (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
  mapping_id uuid not null,observed_from timestamptz not null,observed_to timestamptz not null,
  metrics jsonb not null,coverage jsonb not null,quality_status text not null check(quality_status in ('insufficient','passed')),
  limitations jsonb not null default '[]',created_at timestamptz not null default now(),unique(workspace_id,id),
  foreign key(workspace_id,mapping_id) references public.ad_mappings(workspace_id,id),check(observed_to>observed_from)
);
create table public.learning_conclusions (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
  campaign_id uuid not null,card_version_id uuid not null,metric_snapshot_id uuid not null,
  conclusion jsonb not null,status text not null check(status in ('candidate','adopted','dismissed')),
  created_at timestamptz not null default now(),unique(workspace_id,id),
  foreign key(workspace_id,campaign_id) references public.campaigns(workspace_id,id),
  foreign key(workspace_id,card_version_id) references public.card_versions(workspace_id,id),
  foreign key(workspace_id,metric_snapshot_id) references public.metric_snapshots(workspace_id,id)
);
create table public.outbox_events (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
  topic text not null,payload jsonb not null,created_at timestamptz not null default now(),delivered_at timestamptz
);

-- Enforce workspace ownership on every pre-existing domain relationship.
do $$ declare r record; begin
  for r in select * from (values
    ('brand_snapshots','brand_id','brands'),('brand_facts','brand_snapshot_id','brand_snapshots'),
    ('campaigns','brand_id','brands'),('campaigns','brand_snapshot_id','brand_snapshots'),
    ('campaign_briefs','campaign_id','campaigns'),('discovery_runs','campaign_id','campaigns'),
    ('discovery_runs','brand_snapshot_id','brand_snapshots'),('discovery_runs','brief_id','campaign_briefs'),
    ('evidence','discovery_run_id','discovery_runs'),('market_signals','discovery_run_id','discovery_runs'),
    ('market_signals','evidence_id','evidence'),('campaign_cards','campaign_id','campaigns'),
    ('card_versions','card_id','campaign_cards'),('card_versions','discovery_run_id','discovery_runs'),
    ('creative_packages','campaign_id','campaigns'),('creative_packages','card_id','campaign_cards'),
    ('creative_packages','card_version_id','card_versions'),('creative_angles','package_id','creative_packages'),
    ('generation_configs','package_id','creative_packages'),('assets','campaign_id','campaigns'),
    ('assets','package_id','creative_packages'),('assets','creative_angle_id','creative_angles'),
    ('assets','card_version_id','card_versions'),('assets','generation_config_id','generation_configs'),
    ('jobs','campaign_id','campaigns'),('job_steps','job_id','jobs')
  ) as refs(child,column_name,parent) loop
    execute format('alter table public.%I add constraint %I foreign key(workspace_id,%I) references public.%I(workspace_id,id)',r.child,r.child||'_'||r.column_name||'_workspace_fk',r.column_name,r.parent);
  end loop;
end $$;

create function public.reject_version_mutation() returns trigger language plpgsql as $$
begin raise exception 'Published versions and audit events are immutable'; end $$;
create trigger card_versions_immutable before update on public.card_versions for each row execute function public.reject_version_mutation();
create trigger generation_configs_immutable before update on public.generation_configs for each row execute function public.reject_version_mutation();
create trigger campaign_briefs_immutable before update on public.campaign_briefs for each row execute function public.reject_version_mutation();
create trigger audit_events_immutable before update or delete on public.audit_events for each row execute function public.reject_version_mutation();

create function public.check_learning_quality() returns trigger language plpgsql set search_path=public as $$
begin
  if not exists(select 1 from public.metric_snapshots m join public.ad_mappings a on a.id=m.mapping_id
    join public.launch_plans p on p.id=a.launch_plan_id where m.id=new.metric_snapshot_id
    and m.workspace_id=new.workspace_id and m.quality_status='passed' and a.confirmation_status='confirmed'
    and p.campaign_id=new.campaign_id and p.card_version_id=new.card_version_id)
  then raise exception 'Learning requires confirmed mapping and qualified data from the same Card'; end if;
  return new;
end $$;
create trigger learning_quality before insert or update on public.learning_conclusions for each row execute function public.check_learning_quality();

do $$ declare t text; begin
  foreach t in array array['provider_calls','launch_plans','ad_mappings','metric_snapshots','learning_conclusions','outbox_events'] loop
    execute format('alter table public.%I enable row level security',t);
    if t not in ('provider_calls','outbox_events') then
      execute format('create policy "read workspace data" on public.%I for select using(public.is_workspace_member(workspace_id))',t);
    end if;
  end loop;
end $$;

-- Only the Core API service role can claim steps. Execution services have no DB credentials.
create function public.claim_job_step(target_workspace uuid, worker_name text, allowed_types text[])
returns setof public.job_steps language plpgsql security definer set search_path=public as $$
declare target_id uuid;
begin
  select st.id into target_id from public.job_steps st join public.jobs j on j.id=st.job_id
    where st.workspace_id=target_workspace and j.job_type=any(allowed_types)
      and j.status in ('queued','running') and st.status='queued' and st.available_at<=now()
      order by j.created_at,st.step_key for update of st skip locked limit 1;
  if target_id is null then return; end if;
  return query update public.job_steps set status='running',lease_id=gen_random_uuid(),lease_owner=worker_name,
    lease_expires_at=now()+interval '60 seconds',started_at=now(),attempt_count=attempt_count+1 where id=target_id returning *;
end $$;
revoke all on function public.claim_job_step(uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.claim_job_step(uuid,text,text[]) to service_role;
