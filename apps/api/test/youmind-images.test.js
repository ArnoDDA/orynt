import test from 'node:test';
import assert from 'node:assert/strict';
import { YouMindVideoProvider } from '../src/youmind-video-provider.js';
import { extractImageResult,referenceEvidence,productReferenceEvidence,downloadImage,MAX_KEYFRAME_BYTES } from '../src/youmind-images.js';

const url='https://cdn.youmindassets.com/gen-images/approved.png';
const messages=[{role:'assistant',status:'success',blocks:[{toolName:'image_generate',status:'success',toolResult:{image_urls:[url]}}]}];
test('structured provider question is resumable without misreporting a missing video or resubmitting',async()=>{
  const calls=[];
  const p=new YouMindVideoProvider({apiKey:'test',fetchImpl:async(endpoint,options)=>{calls.push(endpoint);return new Response(JSON.stringify({messages:[{role:'assistant',status:'success',blocks:[{type:'tool',toolName:'ask_user_question',status:'success',toolResult:{status:'waiting_for_answer',questions:[{question:'Choose quality'}]}}]}]}));}});
  const result=await p.poll({chatId:'chat',prompt:'one video',reference:{url},allowConfirmation:false});
  assert.equal(result.stage,'awaiting_confirmation');assert.equal(calls.length,1);assert.ok(calls[0].endsWith('/listMessages'));
});
test('product reference proof belongs to the actual successful image call and tolerates CDN resize parameters',()=>{
  const reference='https://cdn.youmindassets.com/assets/product-hash';
  const wrap=(input,result=url,status='success')=>[{blocks:[{toolName:'generate_image',status,toolArguments:JSON.stringify(input),toolResult:{image_urls:[result]}}]}];
  assert.equal(productReferenceEvidence(wrap({source_image_urls:[reference+'?resize=1024']}),reference,url).status,'product_reference_confirmed');
  for(const m of [wrap({prompt:reference}),wrap({source_image_urls:[reference]},url,'failed'),wrap({source_image_urls:[reference]},url.replace('approved','other')),wrap({source_image_urls:[reference+'-wrong']}),wrap({source_image_urls:[reference.replace('cdn.youmindassets.com','example.com')]})]){
    assert.equal(productReferenceEvidence(m,reference,url).status,'unverified');
  }
});
test('public photo import must preserve the frozen original fingerprint before generation',async()=>{
  const fingerprint='a'.repeat(64);let fileUrl='https://cdn.youmindassets.com/assets/'+fingerprint,calls=0;
  const p=new YouMindVideoProvider({apiKey:'test',fetchImpl:async()=>{calls++;return new Response(JSON.stringify({type:'image',file:{url:fileUrl}}));}});
  const result=await p.readProductReference({fileId:'file',sha256:fingerprint});
  assert.equal(result.url,fileUrl);
  fileUrl='https://cdn.youmindassets.com/assets/'+'b'.repeat(64);
  await assert.rejects(()=>p.readProductReference({fileId:'file',sha256:fingerprint}),{code:'PRODUCT_REFERENCE_IDENTITY_MISMATCH'});
  assert.equal(calls,2);
});
test('keyframes use actual image tool results, never prose, unsupported hosts or a silent batch choice',()=>{
  assert.equal(extractImageResult(messages).url,url);
  assert.deepEqual(extractImageResult([{blocks:[{toolName:'generate_image',status:'success',toolResult:{image_urls:[url],original_image_urls:[url.replace('approved','original')],mediaIds:['image-id']}}]}]),{url:url.replace('approved','original'),mediaId:'image-id',source:'youmind_generated',purpose:'first_frame'});
  for(const value of [[],[{content:url}],[{blocks:[{toolName:'image_generate',status:'failed',toolResult:{image_urls:[url]}}]}],[{blocks:[{toolName:'image_generate',status:'success',toolResult:{image_urls:[url,url.replace('approved','other')]}}]}],[{blocks:[{toolName:'image_generate',status:'success',toolResult:{image_urls:['https://example.com/fake.png']}}]}]])assert.equal(extractImageResult(value),null);
});
test('only actual image input proves reference use; prompt/output echoes do not prove first-frame binding',()=>{
  const wrap=input=>[{blocks:[{toolName:'generate_seedance_video',toolInput:input}]}];
  assert.equal(referenceEvidence(wrap({prompt:`Use ${url}`}),url).status,'unverified');
  assert.equal(referenceEvidence([{content:url,blocks:[{toolName:'image_generate',toolInput:{image_urls:[url]}}]}],url).status,'unverified');
  assert.equal(referenceEvidence(wrap({image_urls:[url]}),url).status,'reference_confirmed');
  assert.equal(referenceEvidence(wrap({first_frame_url:url}),url).status,'first_frame_confirmed');
  assert.equal(referenceEvidence(wrap({mode:'keyframe',first_frame_image:{url,is_real_person:false}}),url).status,'first_frame_confirmed');
  assert.equal(referenceEvidence([{blocks:[{toolName:'generate_seedance_video',toolArguments:JSON.stringify({first_frame_url:url})}]}],url).status,'first_frame_confirmed');
  assert.equal(referenceEvidence(wrap({content:[{type:'image_url',role:'first_frame',image_url:{url}}]}),url).status,'first_frame_confirmed');
  assert.equal(referenceEvidence(wrap({first_frame_url:'https://cdn.youmindassets.com/wrong.png'}),url).status,'unverified');
});
test('image and image-conditioned video submissions use documented chat APIs with the exact approved image',async()=>{
  const calls=[];
  const p=new YouMindVideoProvider({apiKey:'test',fetchImpl:async(endpoint,options)=>{calls.push({endpoint,body:JSON.parse(options.body)});return {ok:true,text:async()=>JSON.stringify({chatId:'image-chat',messages})};}});
  assert.equal((await p.createKeyframe({prompt:'Generate one image only.'})).chatId,'image-chat');
  assert.equal((await p.pollKeyframe({chatId:'image-chat'})).url,url);
  await p.create({prompt:`Use approved image ${url}`,reference:{url,chatId:'image-chat',mediaId:'01a167ea-4ccf-75d5-a7b0-8a78a66ad780'}});
  assert.ok(calls[2].endpoint.endsWith('/sendMessage'));
  assert.equal(calls[2].body.chatId,'image-chat');
  assert.ok(calls[2].body.message.includes(url));
  assert.deepEqual(calls[2].body.atReferences.map(r=>({id:r.id,type:r.type})),[{id:'01a167ea-4ccf-75d5-a7b0-8a78a66ad780',type:'file'}]);
  await assert.rejects(()=>p.create({prompt:'x',reference:{url:'file:///private.png',chatId:'image-chat'}}),{code:'INVALID_KEYFRAME_REFERENCE'});
  assert.equal(calls.length,3);
});
test('image downloads reject redirects, oversized or non-image data without exposing a key',async()=>{
  const png=Buffer.from('89504e470d0a1a0a00000000','hex');
  const p=async(_url,options)=>{assert.equal(options.redirect,'error');assert.equal(options.headers,undefined);return new Response(png);};
  assert.equal((await downloadImage(p,url)).mime,'image/png');
  await assert.rejects(()=>downloadImage(p,'https://localhost/keyframe.png'),{code:'INVALID_KEYFRAME_URL'});
  await assert.rejects(()=>downloadImage(async()=>new Response('<svg>fake</svg>'),url),{code:'INVALID_KEYFRAME'});
  let cancelled=false;
  await assert.rejects(()=>downloadImage(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':String(MAX_KEYFRAME_BYTES+1)}}),url),{code:'ASSET_TOO_LARGE'});
  assert.equal(cancelled,true);
});
test('generated originals above 5 MB retain exact bytes; unknown or dishonest lengths cannot bypass the streaming limit',async()=>{
  const bytes=Buffer.alloc(6*1024*1024);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);
  const result=await downloadImage(async()=>new Response(bytes),url);
  assert.equal(result.mime,'image/png');assert.deepEqual(result.bytes,bytes);
  for(const length of [undefined,'8']){
    let cancelled=false;
    const body=new ReadableStream({pull(controller){controller.enqueue(Buffer.alloc(1024*1024));},cancel(){cancelled=true;}});
    await assert.rejects(()=>downloadImage(async()=>new Response(body,{headers:length?{'content-length':length}:{}}),url),{code:'ASSET_TOO_LARGE'});
    assert.equal(cancelled,true);
  }
});

test('terminal video-tool errors are identified before generic completion or credit confirmation',async()=>{
  let calls=0;
  const p=new YouMindVideoProvider({apiKey:'test',fetchImpl:async()=>{calls++;return new Response(JSON.stringify({messages:[{id:'video-turn',role:'assistant',status:'success',blocks:[
    {id:'failed-call',toolName:'generate_seedance_video',status:'errored',toolArguments:{first_frame_image:{url:`${url}.`}},toolResult:{code:'VideoInternalError'},toolOutput:{type:'error-text',value:'Generation failed'}},
    {type:'content',data:'Please confirm another attempt.'}
  ]}]}));}});
  await assert.rejects(()=>p.poll({chatId:'chat',reference:{url},prompt:'generate'}),error=>{
    assert.equal(error.code,'VIDEO_REFERENCE_MISMATCH');assert.equal(error.providerFailure.confirmedNoVideo,true);
    assert.equal(error.providerFailure.actualReference,`${url}.`);assert.equal(error.providerFailure.expectedReference,url);return true;
  });
  assert.equal(calls,1,'a failed tool must not be automatically confirmed/resubmitted');
});

test('video polling scopes old successes and failures to the current request, including identical resubmission prompts',async()=>{
  let messages=[
    {role:'user',content:'make video',createdAt:'2026-10-28T01:00:00Z'},
    {role:'assistant',status:'success',createdAt:'2026-10-28T01:00:01Z',blocks:[{toolName:'generate_seedance_video',status:'success',toolResult:{gen_media_id:'old'},toolOutput:{value:'https://cdn.youmindassets.com/old.mp4'}}]}
  ];
  const p=new YouMindVideoProvider({apiKey:'test',fetchImpl:async()=>new Response(JSON.stringify({messages}))});
  const args={chatId:'chat',prompt:'make video',submissionStartedAt:'2026-10-28T02:00:00Z',reference:{url},allowConfirmation:false};
  assert.equal((await p.poll(args)).status,'pending');
  messages.push({role:'user',content:'make video',createdAt:'2026-10-28T02:00:00Z'},{role:'assistant',status:'generating',createdAt:'2026-10-28T02:00:00Z',blocks:[]});
  assert.equal((await p.poll(args)).status,'pending');
  messages.at(-1).status='success';messages.at(-1).blocks=[{toolName:'generate_seedance_video',status:'success',toolArguments:{first_frame_image:{url}},toolResult:{gen_media_id:'new',video_url:'https://cdn.youmindassets.com/new.mp4'}}];
  const result=await p.poll(args);assert.equal(result.mediaId,'new');assert.equal(result.controlEvidence.status,'first_frame_confirmed');
});

test('rechecking a provider request never sends a confirmation and errored outputs cannot be accepted as video',async()=>{
  let calls=0;
  const p=new YouMindVideoProvider({apiKey:'test',fetchImpl:async()=>{calls++;return new Response(JSON.stringify({messages:[{role:'assistant',status:'success',blocks:[{type:'content',data:'Please confirm generation.'}]}]}));}});
  assert.equal((await p.poll({chatId:'chat',prompt:'video',allowConfirmation:false})).stage,'awaiting_confirmation');
  assert.equal(calls,1);
  const bad=new YouMindVideoProvider({apiKey:'test',fetchImpl:async()=>new Response(JSON.stringify({messages:[{role:'assistant',status:'success',blocks:[{toolName:'generate_seedance_video',status:'errored',toolResult:{gen_media_id:'bad'},toolOutput:{value:'https://cdn.youmindassets.com/not-generated.mp4'}}]}]}))});
  await assert.rejects(()=>bad.poll({chatId:'chat'}),{code:'VIDEO_PROVIDER_FAILED'});
});
