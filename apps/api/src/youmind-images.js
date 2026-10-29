// Based on the official YouMind image_generate result, not URLs in assistant prose.
const allowedHost = 'cdn.youmindassets.com';
// Generated originals are often larger than user-uploaded brand assets. Keep the
// exact provider bytes for review/reference identity, with a separate bounded cap.
export const MAX_KEYFRAME_BYTES = 32 * 1024 * 1024;
export function imageUrl(value) {
  try {
    const u=new URL(value);
    return u.protocol==='https:' && u.hostname===allowedHost && !u.username && !u.password && (!u.port||u.port==='443') && /\.(png|jpe?g|webp)$/i.test(u.pathname) ? u.href : null;
  } catch { return null; }
}

export function extractImageResult(messages) {
  for (const message of [...(messages||[])].reverse()) for (const block of [...(message.blocks||[])].reverse()) {
    if (!['image_generate','generate_image','generateImage'].includes(block.toolName) || !['success','succeeded','completed'].includes(block.status)) continue;
    const result=block.toolResult||block.toolResponse;
    const urls=[...new Set((result?.original_image_urls?.length?result.original_image_urls:result?.image_urls||[]).map(imageUrl).filter(Boolean))];
    // An unexpected batch is not silently treated as a single approved candidate.
    if (urls.length===1) return {url:urls[0],...(result?.mediaIds?.length===1?{mediaId:result.mediaIds[0]}:{}),source:'youmind_generated',purpose:'first_frame'};
  }
  return null;
}

export function referenceEvidence(messages, referenceUrl) {
  // Only explicit video-tool input counts. Repeating a URL in chat/output is no proof.
  for (const message of [...(messages||[])].reverse()) for (const block of [...(message.blocks||[])].reverse()) {
    if (!['generate_seedance_video','generateSeedanceVideo'].includes(block.toolName)) continue;
    let input=block.toolArguments||block.toolInput||block.toolArgs||block.toolCall?.arguments;
    if(typeof input==='string'){try{input=JSON.parse(input);}catch{continue;}}
    if(!input||typeof input!=='object')continue;
    if([input.first_frame,input.first_frame_url,input.firstFrameUrl,input.firstFrame,input.first_frame_image?.url].some(v=>v===referenceUrl))return {status:'first_frame_confirmed',source:'video_tool_input'};
    if(Array.isArray(input.content)&&input.content.some(v=>v.role==='first_frame'&&(v.image_url?.url===referenceUrl||v.image_url===referenceUrl)))return {status:'first_frame_confirmed',source:'video_tool_input'};
    const images=[input.image_urls,input.reference_images,input.referenceImages,input.imageUrl,input.image_url,input.images,input.content];
    const containsImage=value=>value===referenceUrl||(Array.isArray(value)&&value.some(containsImage))||(value&&typeof value==='object'&&[value.url,value.image_url,value.imageUrl].some(containsImage));
    if(images.some(containsImage))return {status:'reference_confirmed',source:'video_tool_input'};
  }
  return {status:'unverified',source:'no_explicit_video_tool_input'};
}

export function productReferenceEvidence(messages, referenceUrl, resultUrl) {
  const sameImage=value=>{
    try { const a=new URL(value), b=new URL(referenceUrl); return a.protocol==='https:'&&a.hostname==='cdn.youmindassets.com'&&a.origin===b.origin&&a.pathname===b.pathname; }
    catch { return false; }
  };
  for(const m of messages||[])for(const b of m.blocks||[]) {
    if(!['image_generate','generate_image','generateImage'].includes(b.toolName)||!['success','succeeded','completed'].includes(b.status))continue;
    if(resultUrl&&extractImageResult([{blocks:[b]}])?.url!==resultUrl)continue;
    let input=b.toolArguments||b.toolInput;
    if(typeof input==='string'){try{input=JSON.parse(input);}catch{continue;}}
    const values=[input?.source_image_urls,input?.reference_images,input?.image_urls].flatMap(v=>Array.isArray(v)?v:[]);
    if(values.some(v=>sameImage(typeof v==='string'?v:v?.url)))return {status:'product_reference_confirmed',source:'image_tool_input',referenceUrl};
  }
  return {status:'unverified',source:'no_explicit_image_tool_input'};
}

export async function downloadImage(fetchImpl,url,timeoutMs=120_000) {
  if(!imageUrl(url))throw Object.assign(new Error('关键帧地址不在允许的 YouMind 图片 CDN 范围内。'),{code:'INVALID_KEYFRAME_URL'});
  const response=await fetchImpl(url,{signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
  if(!response.ok)throw Object.assign(new Error('关键帧下载失败。'),{code:'KEYFRAME_DOWNLOAD_FAILED'});
  const tooLarge=()=>Object.assign(new Error('生成图片超过 32 MB 接收上限，已有生成回执已保留；视频尚未提交。'),{code:'ASSET_TOO_LARGE'});
  if(Number(response.headers.get('content-length')||0)>MAX_KEYFRAME_BYTES){await response.body?.cancel();throw tooLarge();}
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>MAX_KEYFRAME_BYTES)throw tooLarge();chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  const mime=bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?'image/png':bytes.subarray(0,3).toString('hex')==='ffd8ff'?'image/jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
  if(!mime)throw Object.assign(new Error('服务返回的关键帧不是有效的 PNG、JPG 或 WebP。'),{code:'INVALID_KEYFRAME'});
  return {bytes,mime};
}
