import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,writeFile,chmod} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createEmptyProductState,productCollections,normalizeProductState} from '../packages/domain/src/product-model.js';

export function storedState(db){
  const state=createEmptyProductState();
  for(const row of db.prepare('SELECT key,value FROM local_meta').all()){
    if(row.key==='workspace'||row.key==='schemaVersion')state[row.key]=JSON.parse(row.value);
  }
  for(const row of db.prepare('SELECT collection_name,payload FROM product_entities ORDER BY rowid').all()){
    if(productCollections.includes(row.collection_name))state[row.collection_name].push(JSON.parse(row.payload));
  }
  for(const row of db.prepare('SELECT idempotency_key,payload FROM command_log').all())state.commands[row.idempotency_key]=JSON.parse(row.payload);
  return normalizeProductState(state);
}
export function mergedState(target,source){
  if(target.workspace.id!==source.workspace.id)throw new Error('Workspace mismatch; no records were overwritten.');
  if(source.jobs.some(j=>['queued','running'].includes(j.status)))throw new Error('Source has unfinished jobs; stop or finish them before merging.');
  const merged=structuredClone(target),added={};
  for(const collection of productCollections){
    const old=new Map(target[collection].map(e=>[e.id,e]));added[collection]=0;
    for(const entity of source[collection]){
      const existing=old.get(entity.id);
      if(existing&&JSON.stringify(existing)!==JSON.stringify(entity))throw new Error(`Conflicting ${collection} record ${entity.id}; merge stopped.`);
      if(!existing){merged[collection].push(structuredClone(entity));old.set(entity.id,entity);added[collection]++;}
    }
  }
  for(const[key,value]of Object.entries(source.commands)){
    if(merged.commands[key]&&JSON.stringify(merged.commands[key])!==JSON.stringify(value))throw new Error('Idempotency key conflict; merge stopped.');
    merged.commands[key]=structuredClone(value);
  }
  return {state:merged,added};
}
async function main(){
  const root=fileURLToPath(new URL('../',import.meta.url));
  const local=join(root,'.local/orynt.sqlite'),shared=join(root,'.local/public-demo/data/orynt.sqlite');
  const targetDb=new DatabaseSync(local,{readOnly:true}),sourceDb=new DatabaseSync(shared,{readOnly:true});
  try{
    const target=storedState(targetDb),source=storedState(sourceDb),result=mergedState(target,source);
    if(!process.argv.includes('--apply')){console.log(JSON.stringify({dryRun:true,added:result.added}));return;}
    // The local service must be stopped: two Repository instances must never write the same state.
    if(!process.argv.includes('--local-service-stopped'))throw new Error('Stop the localhost application before applying this one-time merge.');
    if(await fetch('http://127.0.0.1:4173/api/health',{signal:AbortSignal.timeout(1500)}).catch(()=>null))throw new Error('Local service is still running; no data was changed.');
    const directory=join(root,'.local/backups/shared-workspace-'+new Date().toISOString().replace(/[:.]/g,'-'));
    await mkdir(directory,{recursive:true,mode:0o700});
    await backup(targetDb,join(directory,'local-before.sqlite'));await backup(sourceDb,join(directory,'public-before.sqlite'));
    await chmod(join(directory,'local-before.sqlite'),0o600);await chmod(join(directory,'public-before.sqlite'),0o600);
    const writer=new DatabaseSync(local);
    try{
      writer.exec('BEGIN IMMEDIATE');
      const insert=writer.prepare('INSERT INTO product_entities(collection_name,entity_id,workspace_id,payload,updated_at) VALUES (?,?,?,?,?)');
      for(const collection of productCollections){
        const existing=new Set(target[collection].map(e=>e.id));
        for(const entity of source[collection])if(!existing.has(entity.id))insert.run(collection,entity.id,entity.workspaceId||source.workspace.id,JSON.stringify(entity),entity.updatedAt||entity.createdAt||new Date().toISOString());
      }
      const insertCommand=writer.prepare('INSERT INTO command_log(idempotency_key,payload,created_at) VALUES (?,?,?)');
      for(const[key,value]of Object.entries(source.commands))if(!target.commands[key])insertCommand.run(key,JSON.stringify(value),value.createdAt||new Date().toISOString());
      writer.exec('COMMIT');
    }catch(error){writer.exec('ROLLBACK');throw error;}finally{writer.close();}
    await writeFile(join(directory,'merge-result.json'),JSON.stringify({added:result.added,target:local,source:shared},null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({backup:directory,added:result.added}));
  }finally{targetDb.close();sourceDb.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
