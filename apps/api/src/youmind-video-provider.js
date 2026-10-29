import { extractImageResult, referenceEvidence, productReferenceEvidence, downloadImage, imageUrl } from './youmind-images.js';

const DEFAULT_ENDPOINT = 'https://youmind.com';
const CDN_HOSTS = new Set(['cdn.youmindassets.com']);
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return Object.values(value).map(textOf).join(' ');
}

function findChatId(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.chatId === 'string' && value.chatId) return value.chatId;
  if (typeof value.id === 'string' && value.messages) return value.id;
  for (const child of Object.values(value)) {
    const found = findChatId(child);
    if (found) return found;
  }
  return null;
}

function findVideoResult(messages) {
  for (const message of [...(messages || [])].reverse()) {
    for (const block of [...(message.blocks || [])].reverse()) {
      const result = block.toolResult || block.toolResponse;
      const output = block.toolOutput?.value || block.toolResponse || '';
      if (block.toolName !== 'generate_seedance_video' && block.toolName !== 'generateSeedanceVideo') continue;
      if (block.status && !['success','succeeded','completed'].includes(block.status)) continue;
      const mediaId = result?.gen_media_id || result?.genMediaId;
      const source = `${textOf(result)} ${textOf(output)} ${textOf(block.toolOutput)} ${textOf(block.toolResponse)}`;
      const url = source.match(/https:\/\/cdn\.youmindassets\.com\/[A-Za-z0-9_./?=&%-]+\.mp4/i)?.[0] || null;
      if (mediaId && url) return { mediaId, url, title: result.title, duration: result.duration, format: result.format };
    }
  }
  return null;
}

const videoTool = b => ['generate_seedance_video','generateSeedanceVideo'].includes(b.toolName);
const terminal = status => ['success','succeeded','completed','failed','error','errored','cancelled'].includes(status);
function currentMessages(messages, {prompt,submissionStartedAt}) {
  const afterStart=m=>!submissionStartedAt||!m.createdAt||Date.parse(m.createdAt)>=Date.parse(submissionStartedAt)-1000;
  const userIndex=typeof prompt==='string'?messages.findLastIndex(m=>m.role==='user'&&m.content===prompt&&afterStart(m)):-1;
  if(userIndex>=0)return messages.slice(userIndex);
  // A shared image/video chat contains previous successful and failed takes.
  // Until the new turn appears, do not mistake an old turn for its result.
  if(submissionStartedAt&&messages.some(m=>m.createdAt))return messages.filter(m=>m.createdAt&&afterStart(m));
  const lastUser=messages.findLastIndex(m=>m.role==='user');
  return lastUser>=0?messages.slice(lastUser):messages;
}
function firstFrameInput(block) {
  let input=block.toolArguments||block.toolInput||block.toolArgs||block.toolCall?.arguments;
  if(typeof input==='string'){try{input=JSON.parse(input);}catch{return null;}}
  return input?.first_frame_image?.url||input?.first_frame_url||input?.firstFrameUrl||input?.first_frame||null;
}

function needsConfirmation(value) {
  const waiting = new Set(['waiting_for_answer', 'waiting_for_confirmation', 'requires_confirmation']);
  if (waiting.has(value?.status)) return true;
  const assistant = (value?.messages || []).filter(message => message.role === 'assistant').at(-1);
  if (!assistant) return false;
  if (waiting.has(assistant.status)) return true;
  // The agent may finish its reply while an explicit question tool is waiting.
  // Inspect that tool's structured result, never instructions/reasoning in other tools.
  if ((assistant.blocks || []).some(block => ['ask_user_question', 'askUserQuestion'].includes(block.toolName) && waiting.has((block.toolResult || block.toolResponse)?.status))) return true;
  if (!['success', 'succeeded', 'completed'].includes(assistant.status)) return false;
  const visible = [assistant.content, ...(assistant.blocks || []).filter(block => block.type === 'content').map(block => block.data ?? block.text)].map(textOf).join(' ');
  return /(?:please|could you|can you|would you|need (?:your|you to))[^.!?\n]{0,100}(?:confirm|approv)|(?:请|需要|是否)[^。！？\n]{0,60}(?:确认|同意)/i.test(visible);
}

export class YouMindVideoProvider {
  constructor({ apiKey = process.env.YOUMIND_API_KEY, endpoint = process.env.YOUMIND_API_ENDPOINT || DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch, requestTimeoutMs = 120_000, downloadTimeoutMs = 120_000 } = {}) {
    this.apiKey = apiKey;
    this.endpoint = endpoint.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.downloadTimeoutMs = downloadTimeoutMs;
  }

  get available() { return Boolean(this.apiKey && this.fetch); }

  async call(name, body, timeoutMs = this.requestTimeoutMs) {
    if (!this.available) throw Object.assign(new Error('YouMind 视频服务未配置。'), { code: 'VIDEO_PROVIDER_UNAVAILABLE' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(`${this.endpoint}/openapi/v1/${name}`, {
        method: 'POST', signal: controller.signal,
        headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json', 'x-use-camel-case': 'true' },
        body: JSON.stringify(body)
      });
      const raw = await response.text();
      let data; try { data = JSON.parse(raw); } catch { data = { text: raw }; }
      if (!response.ok) throw Object.assign(new Error(`YouMind 请求失败（${response.status}）。`), { code: 'VIDEO_PROVIDER_ERROR', status: response.status });
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw Object.assign(new Error('YouMind 请求超时，请稍后重试。'), { code: 'VIDEO_PROVIDER_TIMEOUT' });
      throw error;
    } finally { clearTimeout(timer); }
  }

  get supportsKeyframes() { return true; }
  get supportsProductReference() { return true; }

  async importProductReference({url}) {
    const response=await this.call('createFileByUrl',{url,title:'Public product identity reference'});
    if(typeof response.id!=='string')throw Object.assign(new Error('参考图片导入回执不完整，请先核查，未提交生图。'),{code:'PRODUCT_REFERENCE_IMPORT_UNCERTAIN'});
    return {fileId:response.id};
  }

  async readProductReference({fileId,sha256}) {
    const response=await this.call('getFile',{id:fileId});
    if(response.status==='fetching')return {status:'pending'};
    let parsed;
    try{parsed=new URL(response.file?.url);}catch{throw Object.assign(new Error('公开产品图未被识别为可用图片，未提交生图。'),{code:'PRODUCT_REFERENCE_UNAVAILABLE'});}
    if(response.type!=='image'||parsed.protocol!=='https:'||parsed.hostname!=='cdn.youmindassets.com'||!parsed.pathname.endsWith(`/${sha256}`))throw Object.assign(new Error('导入图片与已选原图的文件指纹不一致，请核对，未提交生图。'),{code:'PRODUCT_REFERENCE_IDENTITY_MISMATCH'});
    return {status:'ready',mediaId:fileId,url:parsed.href,source:'product_original'};
  }

  async createKeyframe({ prompt, reference, productReference }) {
    const atReferences=[...(productReference?.mediaId?[{type:'file',id:productReference.mediaId,name:'Actual product identity reference',instruction:'Pass this actual product photo into the image tool source_image_urls/reference image input. Preserve product geometry, color, cap/handle and visible branding. Generate one complete scene, not a cutout overlay.'}]:[]),...(reference?.mediaId?[{type:'file',id:reference.mediaId,name:'Previous approved shot',instruction:'Continuity reference for composition palette and lighting; actual product identity comes from the original product reference. Generate the newly requested composition, not a copy of the previous shot.'}]:[])];
    const response=await this.call('createChat',{message:prompt,...(atReferences.length?{atReferences}:{})});
    const chatId=findChatId(response);
    if(!chatId)throw Object.assign(new Error('YouMind 未返回关键帧任务标识。'),{code:'KEYFRAME_SUBMISSION_UNCERTAIN'});
    let confirmationSent=false;
    if(needsConfirmation(response)){await this.confirm({chatId,prompt});confirmationSent=true;}
    return {chatId,confirmationSent};
  }

  async pollKeyframe({chatId,prompt,confirmationSent=false,productReference}) {
    const response=await this.call('listMessages',{chatId});
    const result=extractImageResult(response.messages);
    if(result)return {status:'succeeded',...result,...(productReference?{productReferenceEvidence:productReferenceEvidence(response.messages,productReference.url,result.url)}:{})};
    const assistant=(response.messages||[]).filter(m=>m.role==='assistant').at(-1);
    if(['failed','error','errored','cancelled'].includes(assistant?.status))throw Object.assign(new Error('关键帧生成失败。'),{code:'KEYFRAME_PROVIDER_FAILED'});
    if(needsConfirmation(response)&&!confirmationSent&&prompt){await this.confirm({chatId,prompt});return {status:'pending',confirmationSent:true};}
    if(['success','succeeded','completed'].includes(assistant?.status)&&!needsConfirmation(response))throw Object.assign(new Error('服务没有返回可核验的单张生成图片，请检查任务后调整镜头。'),{code:'KEYFRAME_RESULT_MISSING'});
    return {status:'pending',confirmationSent,stage:assistant?.status||'waiting'};
  }

  async downloadKeyframe({url}) { return downloadImage(this.fetch,url,this.downloadTimeoutMs); }

  async create({ prompt, reference }) {
    if(reference&&(!reference.chatId||!imageUrl(reference.url)))throw Object.assign(new Error('已确认关键帧的服务引用无效，未提交视频。'),{code:'INVALID_KEYFRAME_REFERENCE'});
    const response = await this.call(reference?'sendMessage':'createChat', { message: prompt, ...(reference?{chatId:reference.chatId,...(reference.mediaId?{atReferences:[{type:'file',id:reference.mediaId,name:'Approved first frame',instruction:'Use this approved generated image as the first-frame image input to the video tool.'}]}:{})}:{}) });
    const chatId = reference?.chatId || findChatId(response);
    if (!chatId) throw Object.assign(new Error('YouMind 未返回任务标识。'), { code: 'VIDEO_PROVIDER_INVALID_RESPONSE' });
    let confirmationSent = false;
    if (needsConfirmation(response)) {
      await this.confirm({ chatId, prompt });
      confirmationSent = true;
    }
    return { chatId, confirmationSent };
  }

  async confirm({ chatId, prompt }) {
    await this.call('sendMessage', {
      chatId,
      message: `确认生成。请严格沿用下面的原始制作要求，不要更改画幅、缩短时长或降级画质；如无法满足，请明确返回限制。不需要再次询问确认。\n\n原始制作要求：\n${prompt}`
    });
  }

  async poll({ chatId, prompt, confirmationSent = false, reference, submissionStartedAt, allowConfirmation = true }) {
    const response = await this.call('listMessages', { chatId });
    const messages = currentMessages(response.messages || [],{prompt,submissionStartedAt});
    const result = findVideoResult(messages);
    if (result) {
      const resultBlocks=messages.flatMap(m=>m.blocks||[]).filter(b=>videoTool(b)&&findVideoResult([{blocks:[b]}])?.mediaId===result.mediaId);
      return { status: 'succeeded', ...result, ...(reference?{controlEvidence:referenceEvidence([{blocks:resultBlocks}],reference.url)}:{}) };
    }
    const assistant = messages.filter(message => message.role === 'assistant').at(-1);
    const lastTool=messages.flatMap(m=>(m.blocks||[]).filter(videoTool).map(block=>({block,messageId:m.id}))).at(-1);
    if(terminal(assistant?.status)&&lastTool&&['failed','error','errored','cancelled'].includes(lastTool.block.status)) {
      const actualReference=firstFrameInput(lastTool.block),mismatch=Boolean(reference&&actualReference&&actualReference!==reference.url);
      throw Object.assign(new Error(mismatch?'视频生成失败：服务使用的参考图地址与已确认图片不一致。图片已保留，可核查后仅重试视频。':'视频生成服务执行失败，未返回视频。已确认图片保留，可核查后仅重试视频。'),{
        code:mismatch?'VIDEO_REFERENCE_MISMATCH':'VIDEO_PROVIDER_FAILED',
        providerFailure:{confirmedNoVideo:true,checkedAt:new Date().toISOString(),messageId:lastTool.messageId,toolCallId:lastTool.block.id,providerCode:lastTool.block.toolResult?.code||null,...(actualReference?{actualReference}:{}),...(reference?{expectedReference:reference.url}:{})}
      });
    }
    const failed = ['failed', 'error', 'errored', 'cancelled'].includes(assistant?.status);
    if (failed) throw Object.assign(new Error('YouMind 视频生成失败。'), { code: 'VIDEO_PROVIDER_FAILED' });
    if (needsConfirmation({messages})) {
      if (allowConfirmation && !confirmationSent && prompt) {
        await this.confirm({ chatId, prompt });
        return { status: 'pending', confirmationSent: true, stage: 'confirmation_sent' };
      }
      return { status: 'pending', confirmationSent, stage: 'awaiting_confirmation' };
    }
    if(reference&&messages.at(-1)===assistant&&['success','succeeded','completed'].includes(assistant?.status))throw Object.assign(new Error('服务已结束回复，但未返回可核验的视频。请先核查已有任务，避免重复生成。'),{code:'REFERENCE_VIDEO_RESULT_MISSING'});
    return { status: 'pending', stage: assistant?.status || 'waiting' };
  }

  async download({ url }) {
    let parsed;
    try { parsed = new URL(url); } catch { throw Object.assign(new Error('YouMind 返回了无效的视频地址。'), { code: 'VIDEO_PROVIDER_INVALID_URL' }); }
    if (parsed.protocol !== 'https:' || !CDN_HOSTS.has(parsed.hostname) || !parsed.pathname.endsWith('.mp4')) {
      throw Object.assign(new Error('视频地址不在允许的 YouMind CDN 范围内。'), { code: 'VIDEO_PROVIDER_INVALID_URL' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    try {
      const response = await this.fetch(parsed, { signal: controller.signal });
      if (!response.ok) throw Object.assign(new Error('无法下载 YouMind 视频。'), { code: 'VIDEO_PROVIDER_DOWNLOAD_FAILED' });
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_VIDEO_BYTES) throw Object.assign(new Error('生成视频超过本地 20 MB 限制。'), { code: 'ASSET_TOO_LARGE' });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_VIDEO_BYTES || bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw Object.assign(new Error('YouMind 返回的文件不是有效 MP4。'), { code: 'INVALID_VIDEO' });
      return bytes;
    } catch (error) {
      if (error.name === 'AbortError') throw Object.assign(new Error('视频下载超时，请稍后重试。'), { code: 'VIDEO_PROVIDER_TIMEOUT' });
      throw error;
    } finally { clearTimeout(timer); }
  }
}

export function extractVideoResultForTest(messages) { return findVideoResult(messages); }
