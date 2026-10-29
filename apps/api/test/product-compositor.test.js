import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {LocalVideoAssembler} from '../src/video-assembler.js';
const run=promisify(execFile);

test('real local photo compositor preserves white/alpha products and uses identical still/video layout',async t=>{
  const assembler=new LocalVideoAssembler();
  try{await assembler.check();}catch{t.skip('Local FFmpeg/Pillow runtime unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'orynt-original-photo-test-'));
  try{
    // Synthetic fixtures test pixels only; never claimed to be real advertising.
    await run(assembler.python,['-B','-c',`from PIL import Image,ImageDraw
import sys,os
d=sys.argv[1]
for mode in ('opaque','alpha','empty'):
 im=Image.new('RGBA',(240,360),(255,255,255,255) if mode=='opaque' else (0,0,0,0))
 if mode!='empty':
  draw=ImageDraw.Draw(im);draw.rectangle((40,40,200,320),fill=(255,255,255,255));draw.rectangle((100,100,140,240),fill=(220,30,40,255))
 im.save(os.path.join(d,mode+'.png'))
Image.new('RGB',(720,1280),(30,70,90)).save(os.path.join(d,'background.png'))`,dir]);
    await run(assembler.ffmpeg,['-v','error','-f','lavfi','-i','color=c=0x1e465a:s=720x1280:r=24:d=1','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',join(dir,'background.mp4')]);
    const background=await readFile(join(dir,'background.png')),video=await readFile(join(dir,'background.mp4'));
    let previousHash;
    for(const mode of ['opaque','alpha']) {
      const original=await readFile(join(dir,mode+'.png')),image={assetId:mode,base64:original.toString('base64')};
      const still=await assembler.productPreview(background,image,{ratio:'9:16',index:0});
      const shot=await assembler.productShot(video,image,{ratio:'9:16',index:0});
      assert.equal(still.composition.sourceSha256,createHash('sha256').update(original).digest('hex'));
      assert.notEqual(still.composition.sourceSha256,previousHash);previousHash=still.composition.sourceSha256;
      assert.equal(shot.composition.sourceSha256,still.composition.sourceSha256);
      assert.deepEqual(shot.composition.plate,still.composition.plate);assert.equal(shot.composition.network,false);
      assert.equal(still.composition.treatment,mode==='opaque'?'original_photo_plate':'original_alpha');
      await writeFile(join(dir,'preview.jpg'),Buffer.from(still.base64,'base64'));await writeFile(join(dir,'shot.mp4'),shot.bytes);
      const inspected=await assembler.inspect(shot.bytes,{duration:1,ratio:'9:16',audio:false});assert.deepEqual(inspected.technical.issues,[]);
      await run(assembler.ffmpeg,['-v','error','-i',join(dir,'shot.mp4'),'-frames:v','1','-y',join(dir,'video-frame.png')]);
      const {stdout}=await run(assembler.python,['-B','-c',`from PIL import Image
import sys,os,json
d=sys.argv[1]
print(json.dumps([[Image.open(os.path.join(d,n)).convert('RGB').getpixel(p) for p in ((360,576),(240,576))] for n in ('preview.jpg','video-frame.png')]))`,dir]);
      for(const [red,white]of JSON.parse(stdout)){
        assert.ok(red[0]>170&&red[1]<80,'original red mark visible in both previews');
        assert.ok(white.every(v=>v>225),'white product pixels are never erased');
      }
    }
    for(const ratio of ['1:1','16:9']) {
      const result=await assembler.productPreview(background,{assetId:'opaque',base64:(await readFile(join(dir,'opaque.png'))).toString('base64')},{ratio,index:1});
      assert.equal(result.composition.height,720);assert.equal(result.composition.width,ratio==='1:1'?720:1280);
    }
    await assert.rejects(()=>assembler.productPreview(null,{base64:(Buffer.from([])).toString('base64')},{ratio:'9:16',index:0}),{code:'PRODUCT_COMPOSITION_FAILED'});
    const empty=(await readFile(join(dir,'empty.png'))).toString('base64');
    await assert.rejects(()=>assembler.productPreview(null,{base64:empty},{ratio:'9:16',index:0}),{code:'PRODUCT_COMPOSITION_FAILED'});
  }finally{await rm(dir,{recursive:true,force:true});}
});
