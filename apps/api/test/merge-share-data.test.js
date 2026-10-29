import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmptyProductState} from '../../../packages/domain/src/product-model.js';
import {mergedState} from '../../../scripts/merge-share-data.mjs';

test('one-time merge retains all local originals and public project relationships, and is idempotent',()=>{
  const local=createEmptyProductState(),publicState=createEmptyProductState();
  local.brands.push({id:'local-brand',name:'Original'});
  local.brandAssets.push({id:'original-image',brandId:'local-brand',base64:'exact-original-bytes'});
  local.assets.push({id:'original-film',base64:'exact-film-bytes'});
  publicState.brands.push({id:'public-brand',name:'New public project'});
  publicState.campaigns.push({id:'public-campaign',brandId:'public-brand',briefId:'public-brief'});
  publicState.briefs.push({id:'public-brief',campaignId:'public-campaign'});
  publicState.commands['public-command']={result:{campaignId:'public-campaign'}};
  const result=mergedState(local,publicState);
  assert.deepEqual(result.state.brandAssets,local.brandAssets);
  assert.deepEqual(result.state.assets,local.assets);
  assert.equal(result.state.campaigns[0].brandId,'public-brand');
  assert.equal(result.state.commands['public-command'].result.campaignId,'public-campaign');
  assert.deepEqual(mergedState(result.state,publicState).state,result.state);
  assert.equal(local.campaigns.length,0);
});

test('merge stops on conflicting records or unfinished source jobs without overwriting data',()=>{
  const local=createEmptyProductState(),source=createEmptyProductState();
  local.brands.push({id:'same-id',name:'Keep original'});source.brands.push({id:'same-id',name:'Conflicting'});
  assert.throws(()=>mergedState(local,source),/Conflicting/);assert.equal(local.brands[0].name,'Keep original');
  source.brands=[];source.jobs.push({id:'pending',status:'queued'});
  assert.throws(()=>mergedState(local,source),/unfinished/);
});
