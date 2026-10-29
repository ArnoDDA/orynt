import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalVideoAssembler } from '../src/video-assembler.js';
const run=promisify(execFile);

test('keyframe validation decodes a real image and refuses truncated content before approval',async t=>{
  const assembler=new LocalVideoAssembler();
  try{await assembler.check();}catch{t.skip('Local FFmpeg/Pillow runtime is unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'orynt-keyframe-decode-test-'));
  try{
    const path=join(dir,'frame.png');
    await run(assembler.ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=720x1280','-frames:v','1',path],{timeout:30_000});
    const bytes=await readFile(path);
    assert.deepEqual(await assembler.inspectKeyframe(bytes,{ratio:'9:16'}),{width:720,height:1280,issues:[]});
    await assert.rejects(()=>assembler.inspectKeyframe(bytes.subarray(0,Math.floor(bytes.length/2)),{ratio:'9:16'}),{code:'INVALID_KEYFRAME'});
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('local compositor encodes three correctly timed scenes with original photo, typography and an audio track',async t=>{
  const assembler=new LocalVideoAssembler();
  try{await assembler.check();}catch{t.skip('Local FFmpeg/Pillow runtime is unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'orynt-compositor-test-'));
  try{
    const ff=args=>run(assembler.ffmpeg,['-hide_banner','-loglevel','error',...args],{timeout:90_000});
    // Synthetic encoder fixtures; these are never presented as generated advertising.
    await ff(['-f','lavfi','-i','color=c=0x355042:s=720x1280:r=24:d=3','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',join(dir,'source.mp4')]);
    await ff(['-f','lavfi','-i','color=c=0xc59853:s=200x300','-frames:v','1',join(dir,'product.png')]);
    const base64=(await readFile(join(dir,'source.mp4'))).toString('base64');
    const request={cardVersionId:'card-v1',production:{brandName:'本地排版测试 / Coffee',product:'真实产品照片',copy:{opening:'从一个好镜头开始',detail:'清楚的产品表达',cta:'了解产品'},music:'ambient',productImage:{assetId:'original-photo',base64:(await readFile(join(dir,'product.png'))).toString('base64')},shots:[{index:0,version:1,base64,targetDuration:3,start:0,end:3,kind:'generated_shot'},{index:1,version:2,base64,targetDuration:3,start:3,end:6,kind:'generated_shot'},{index:2,version:1,targetDuration:4,start:6,end:10,kind:'product_endcard'}]}};
    const result=await assembler.assemble(request,{id:'config-v1',duration:10,ratio:'9:16'});
    assert.deepEqual(result.technical.issues,[]);assert.equal(result.technical.hasAudio,true);assert.equal(result.technical.width,720);assert.ok(Math.abs(result.technical.duration-10)<.15);
    assert.equal(result.manifest.productImageTreatment,'local_original_endcard');assert.equal(result.manifest.shots[1].version,2);
    const output=join(dir,'result.mp4');await writeFile(output,Buffer.from(result.base64,'base64'));
    const {stdout}=await run(assembler.ffmpeg,['-v','error','-ss','8','-i',output,'-frames:v','1','-vf','crop=2:2:360:640','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer'});
    assert.ok(stdout[0]>120&&stdout[0]>stdout[2],'endcard contains the original gold product fixture');
    const inspected=await assembler.inspect(Buffer.from(base64,'base64'),{duration:10,ratio:'1:1'});
    assert.ok(inspected.technical.issues.includes('时长与要求不符'));assert.ok(inspected.technical.issues.includes('画幅与要求不符'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
