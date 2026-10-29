import test from 'node:test';
import assert from 'node:assert/strict';
import {fixedEndpoint} from '../../../scripts/fixed-tunnel.mjs';

test('fixed sharing accepts only a confirmed HTTPS tunnel and refuses silent address replacement',()=>{
  const event=url=>JSON.stringify({msg:'started tunnel',url});
  const origin='https://orynt-example.ngrok-free.app';
  assert.equal(fixedEndpoint(event(origin)),origin);
  assert.equal(fixedEndpoint(event(origin),origin),origin);
  assert.throws(()=>fixedEndpoint(event('https://different.ngrok-free.app'),origin),/FIXED_ADDRESS_CHANGED/);
  for(const url of ['http://orynt-example.ngrok-free.app','https://user:pass@orynt-example.ngrok-free.app','https://orynt-example.ngrok-free.app.evil.test','https://orynt-example.ngrok-free.app/private'])assert.equal(fixedEndpoint(event(url)),null);
  assert.equal(fixedEndpoint(JSON.stringify({url:origin,msg:'opening'})),null);
  assert.equal(fixedEndpoint('not json'),null);
});
