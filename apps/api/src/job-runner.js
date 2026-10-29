import { LocalWebsiteCrawler } from './website-crawler.js';
import { LocalMetaAdsCrawler } from './meta-ads-crawler.js';
import { YouMindVideoProvider } from './youmind-video-provider.js';
import { buildVideoPrompt } from './video-prompt.js';
import { LocalVideoTemplateAnalyzer } from './video-template-analyzer.js';
import { LocalProductImporter } from './product-importer.js';
import { LocalVideoAssembler } from './video-assembler.js';
import { ProductionRunner } from './production-runner.js';
import { ProductStrategyPlanner } from './product-strategy-planner.js';
import { planningContext } from '../../../packages/domain/src/product-planning.js';
import { buildMarketBrief } from '../../../packages/domain/src/market-planning.js';

function marketQuery(brand, brief) {
  const name = String(brand?.name || '').replace(/\s+/g, ' ').trim();
  if (name) return name.slice(0, 120);
  const product = String(brief?.product || '').replace(/\s+/g, ' ').trim();
  return (product || new URL(brand.websiteUrl).hostname.replace(/^www\./, '')).slice(0, 120);
}

function unavailableBundle(source, error) {
  return {
    provider: source,
    sources: [],
    evidence: [],
    coverage: {},
    limitations: [`${source === 'orynt_local_website' ? '品牌官网' : 'Meta 广告样本'}采集未完成：${error?.message || '未知错误'}`]
  };
}

function mergeDiscoveryBundles(bundles) {
  const sources = [], evidence = [], limitations = [];
  const coverage = {
    attemptedPages: 0, fetchedPages: 0, failedPages: 0, robotsBlockedPages: 0,
    metaSamples: 0, liveMetaAds: 0, demoMetaAds: 0, externalSignals: 0, visualAds:0
  };
  for (const bundle of bundles) {
    sources.push(...(bundle.sources || []).map(item => ({ ...item, provider: item.provider || bundle.provider })));
    evidence.push(...(bundle.evidence || []));
    limitations.push(...(bundle.limitations || []));
    for (const key of Object.keys(coverage)) coverage[key] += Number(bundle.coverage?.[key] || 0);
  }
  return {
    provider: 'orynt_local_discovery', sources, evidence, coverage,
    limitations: [...new Set(limitations)]
  };
}

export class LocalJobRunner {
  constructor({ core, repository, crawler = new LocalWebsiteCrawler(), metaCrawler = new LocalMetaAdsCrawler(), videoProvider = new YouMindVideoProvider(), templateAnalyzer = new LocalVideoTemplateAnalyzer(), productImporter = new LocalProductImporter(), videoAssembler = new LocalVideoAssembler(), strategyPlanner = new ProductStrategyPlanner() }) {
    this.core = core;
    this.repository = repository;
    this.crawler = crawler;
    this.metaCrawler = metaCrawler;
    this.videoProvider = videoProvider;
    this.templateAnalyzer = templateAnalyzer;
    this.productImporter = productImporter;
    this.strategyPlanner = strategyPlanner;
    this.productionRunner = new ProductionRunner({ core, repository, videoProvider, videoAssembler });
    this.running = false;
    this.lastJobId = null;
  }

  async tick() {
    if (this.running) {
      if (this.productRead) {
        const current = this.repository.read().jobs.find(job => job.id === this.productRead.jobId);
        if (!current || !['queued', 'running'].includes(current.status) || current.attemptId !== this.productRead.attemptId) this.productRead.controller.abort();
      }
      return;
    }
    this.running = true;
    try {
      const state = this.repository.read();
      const eligible = state.jobs.filter(item => ['queued', 'running'].includes(item.status) && !(item.type === 'production' && ['awaiting_review','awaiting_keyframe_review'].includes(state.generationRequests.find(r=>r.id===item.input.generationRequestId)?.production?.phase)));
      if (!eligible.length) return;
      // A provider waiting for its next poll must not monopolize the workspace.
      const previous = eligible.findIndex(item => item.id === this.lastJobId);
      const job = eligible[(previous + 1) % eligible.length];
      if (!job) return;
      this.lastJobId = job.id;
      if (job.type === 'reference_media') {
        const current = () => this.repository.read().jobs.some(j => j.id === job.id && j.attemptId === job.attemptId && ['queued','running'].includes(j.status));
        try {
          const evidence = state.evidence.filter(e => job.input.evidenceIds.includes(e.id)).map(e => ({id:e.id,sourceUrl:e.sourceUrl,rawEvidenceRef:e.rawEvidenceRef || state.evidence.find(original => original.sourceUrl === e.sourceUrl && original.rawEvidenceRef)?.rawEvidenceRef}));
          const directAdIds = job.directMediaStartedAt ? [] : job.input.directAdIds || [];
          if (directAdIds.length) this.repository.transact(s => {s.jobs.find(j => j.id === job.id).directMediaStartedAt = new Date().toISOString();});
          const result = await this.metaCrawler.hydrate({evidence,directAdIds});
          if (current()) this.core.tick({jobId:job.id,providerResult:result});
        } catch {
          if (current()) this.core.tick({jobId:job.id,error:{code:'REFERENCE_IMAGES_UNAVAILABLE',message:'参考图片暂未取得，已有文案和已保存图片仍可使用。'}});
        }
        return;
      }
      if (job.type==='production' && state.generationRequests.some(r=>r.id===job.input.generationRequestId&&r.localEdit)) { await this.productionRunner.tick(job); return; }
      if (state.campaigns.find(c => c.id === job.campaignId)?.replay) { await this.core.walkthrough.tick(this.core, this.repository, job); return; }
      if (job.type === 'production') { await this.productionRunner.tick(job); return; }
      if (job.type === 'product_import') {
        const stillCurrent = () => this.repository.read().jobs.some(item => item.id === job.id && item.attemptId === job.attemptId && ['queued', 'running'].includes(item.status));
        try {
          if (!job.providerResult) {
            const controller = new AbortController();
            this.productRead = { jobId: job.id, attemptId: job.attemptId, controller };
            const result = await this.productImporter.collect({ url: job.input.url, signal: controller.signal });
            if (stillCurrent()) this.core.tick({ jobId: job.id, providerResult: result });
          } else this.core.tick({ jobId: job.id });
        } catch (error) { if (stillCurrent()) this.core.tick({ jobId: job.id, error: { code: error.code || 'PRODUCT_IMPORT_FAILED', message: error.message || '产品页读取未完成，可以手动填写继续。' } }); }
        finally { this.productRead = null; }
        return;
      }
      if (job.type === 'video') { await this.tickVideo(job); return; }
      if (job.type === 'template_analysis') { await this.tickTemplate(job); return; }
      if (job.type === 'cards' && !job.providerResult && job.steps.find(step => step.status !== 'succeeded')?.key === 'prepare_candidates') {
        const snapshot = state.snapshots.find(s => s.id === job.input.snapshotId);
        if (snapshot?.productImport) {
          const brief = state.briefs.find(b => b.id === job.input.briefId);
          const dossier = planningContext(state, snapshot, brief);
          const discovery = state.discoveries.find(d => d.id === job.input.discoveryId);
          const result = await this.strategyPlanner.plan(dossier, buildMarketBrief(state, discovery, dossier));
          const current = this.repository.read().jobs.find(j => j.id === job.id);
          if (!current || current.attemptId !== job.attemptId || !['queued', 'running'].includes(current.status)) return;
          this.repository.transact(s => { s.jobs.find(j => j.id === job.id).providerResult = result; });
        }
      }
      if (job.type !== 'discovery') {
        this.core.tick({ jobId: job.id });
        return;
      }
      const campaign = state.campaigns.find(item => item.id === job.campaignId);
      if (campaign?.mode === 'guided_demo') {
        this.core.tick({ jobId: job.id, discovery: {
          provider: 'confirmed_demo_brand', sources: [], evidence: [],
          coverage: { sources: 0, externalSignals: 0 },
          limitations: ['演示创作仅使用已确认的示例品牌资料，没有采集真实市场广告；创意效果尚待验证。']
        } });
        return;
      }

      const nextStep = job.steps.find(item => item.status !== 'succeeded');
      if (!nextStep) return;
      let discovery = job.providerResult || null;
      if (nextStep.key === 'check_source_coverage' && !discovery) {
        const campaign = state.campaigns.find(item => item.id === job.campaignId);
        const brand = state.brands.find(item => item.id === campaign?.brandId);
        if (!brand?.websiteUrl) {
          this.core.tick({ jobId: job.id, error: { code: 'BRAND_URL_MISSING', message: '品牌官网地址不存在。' } });
          return;
        }
        const brief = state.briefs.find(item => item.id === campaign.briefId);
        const tasks = [this.crawler.collect({ url: campaign.productUrl || brand.websiteUrl, campaignId: campaign.id, jobId: job.id })];
        if (this.metaCrawler) tasks.push(this.metaCrawler.collect({ query: marketQuery(brand, brief), campaignId: campaign.id, jobId: job.id }));
        const results = await Promise.allSettled(tasks);
        // A cancelled attempt may finish after the same job has been retried.
        const stillCurrent = () => this.repository.read().jobs.some(item => item.id === job.id && item.attemptId === job.attemptId && ['queued', 'running'].includes(item.status));
        if (!stillCurrent()) return;
        const bundles = [
          results[0].status === 'fulfilled' ? results[0].value : unavailableBundle('orynt_local_website', results[0].reason)
        ];
        if (this.metaCrawler) {
          bundles.push(results[1].status === 'fulfilled' ? results[1].value : unavailableBundle('orynt_local_meta_ads', results[1].reason));
        }
        discovery = mergeDiscoveryBundles(bundles);
        this.repository.transact(current => {
          const durableJob = current.jobs.find(item => item.id === job.id && item.attemptId === job.attemptId && ['queued', 'running'].includes(item.status));
          if (durableJob) durableJob.providerResult = discovery;
        });
      }

      this.core.tick({ jobId: job.id, discovery });
    } finally {
      this.running = false;
    }
  }

  async tickTemplate(snapshot) {
    const state = this.repository.read();
    const job = state.jobs.find(item => item.id === snapshot.id && ['queued', 'running'].includes(item.status));
    if (!job) return;
    try {
      const step = job.steps.find(item => item.status !== 'succeeded');
      if (!step) return;
      if (step.key === 'validate_local_video') { this.core.tick({ jobId: job.id }); return; }
      if (step.key === 'detect_scenes' && !job.providerResult) {
        const template = state.videoTemplates.find(item => item.id === job.input.templateId);
        if (!template?.base64) { this.core.tick({ jobId: job.id, error: { code: 'VIDEO_TEMPLATE_MISSING', message: '参考模板原视频不存在。' } }); return; }
        const result = await this.templateAnalyzer.analyze(template);
        this.core.tick({ jobId: job.id, providerResult: result });
        return;
      }
      this.core.tick({ jobId: job.id });
    } catch (error) {
      this.core.tick({ jobId: job.id, error: { code: error.code || 'TEMPLATE_ANALYSIS_ERROR', message: error.message || '参考模板分析未完成。' } });
    }
  }

  async tickVideo(snapshot) {
    const state = this.repository.read();
    const job = state.jobs.find(item => item.id === snapshot.id && ['queued', 'running'].includes(item.status));
    if (!job) return;
    try {
      const step = job.steps.find(item => item.status !== 'succeeded');
      if (!step) return;
      if (step.key === 'validate_card_and_config') { this.core.tick({ jobId: job.id }); return; }
      if (!this.videoProvider?.available) { this.core.tick({ jobId: job.id, error: { code: 'VIDEO_PROVIDER_UNAVAILABLE', message: 'YouMind 视频服务未配置，请检查本地环境变量。' } }); return; }
      if (step.key === 'submit_provider_job') {
        const providerState = job.providerState || {};
        if (!providerState.chatId) {
          const created = await this.videoProvider.create({ prompt: buildVideoPrompt(state, job) });
          this.repository.transact(current => {
            const durable = current.jobs.find(item => item.id === job.id);
            if (durable) { durable.providerState = { chatId: created.chatId, confirmationSent: created.confirmationSent, submittedAt: new Date().toISOString() }; durable.provider = 'youmind'; }
            const request = current.generationRequests.find(item => item.id === job.input.generationRequestId);
            if (request) { request.providerChatId = created.chatId; request.provider = 'youmind'; request.providerStatus = 'submitted'; }
          });
        }
        this.core.tick({ jobId: job.id });
        return;
      }
      const providerState = job.providerState || {};
      if (!providerState.chatId) { this.core.tick({ jobId: job.id, error: { code: 'VIDEO_PROVIDER_STATE_MISSING', message: '视频任务状态缺失，请重试该任务。' } }); return; }
      if (step.key === 'wait_for_provider') {
        const result = await this.videoProvider.poll({ chatId: providerState.chatId, confirmationSent: providerState.confirmationSent, prompt: buildVideoPrompt(state, job) });
        if (result.status === 'pending') {
          this.repository.transact(current => { const durable = current.jobs.find(item => item.id === job.id); if (durable) durable.providerState = { ...durable.providerState, ...(result.confirmationSent !== undefined ? { confirmationSent: result.confirmationSent } : {}), stage: result.stage || 'waiting', lastPolledAt: new Date().toISOString(), providerStatus: 'pending' }; });
          return;
        }
        this.repository.transact(current => { const durable = current.jobs.find(item => item.id === job.id); if (durable) durable.providerState = { ...durable.providerState, ...result, providerStatus: 'succeeded' }; });
        this.core.tick({ jobId: job.id });
        return;
      }
      if (step.key === 'download_result') {
        if (!providerState.url) { this.core.tick({ jobId: job.id, error: { code: 'VIDEO_RESULT_MISSING', message: 'YouMind 未返回可下载的视频。' } }); return; }
        const buffer = await this.videoProvider.download({ url: providerState.url });
        this.core.tick({ jobId: job.id, providerResult: { ...providerState, base64: buffer.toString('base64'), filename: `youmind-${providerState.mediaId || 'video'}.mp4` } });
        return;
      }
      if (step.key === 'publish_asset') { this.core.tick({ jobId: job.id, providerResult: job.providerResult || { ...providerState } }); }
    } catch (error) {
      this.core.tick({ jobId: job.id, error: { code: error.code || 'VIDEO_PROVIDER_ERROR', message: error.message || '视频生成未完成。' } });
    }
  }
}
