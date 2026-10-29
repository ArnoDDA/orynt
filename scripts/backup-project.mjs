// Private local snapshot: includes credentials and all working data. Never publish.
import { cp, mkdir, readdir, readFile, writeFile, lstat, readlink } from 'node:fs/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const source=fileURLToPath(new URL('../',import.meta.url));
const destination=resolve(process.argv[2]);
if(!process.argv[2]||destination.startsWith(source))throw new Error('Supply a new backup folder outside the project.');
await mkdir(destination);
const target=join(destination,'orynt-ai');
await cp(source,target,{recursive:true,verbatimSymlinks:true,preserveTimestamps:true,errorOnExist:true,force:false});
// A SQLite online backup includes committed WAL content, while preserving all
// original database/WAL files separately as raw snapshot files.
const dbPath=join(source,'.local/orynt.sqlite');
const db=new DatabaseSync(dbPath,{readOnly:true});
try{await backup(db,join(destination,'orynt-consistent.sqlite'));}finally{db.close();}
const entries=[];
async function scan(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
  const path=join(dir,entry.name),rel=relative(source,path);
  if(entry.isDirectory())await scan(path);
  else if(entry.isSymbolicLink()){
    const link=await readlink(path);if(await readlink(join(target,rel))!==link)throw new Error('Symlink mismatch: '+rel);entries.push({path:rel,symlink:link});
  }else{
    const a=await readFile(path),b=await readFile(join(target,rel));
    const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
    if(sha(a)!==sha(b))throw new Error('Snapshot file changed during copy: '+rel);
    entries.push({path:rel,bytes:b.length,sha256:sha(b)});
  }
}}
await scan(source);
const snapshot=new DatabaseSync(join(destination,'orynt-consistent.sqlite'),{readOnly:true});
try{if(snapshot.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('SQLite integrity failure');}finally{snapshot.close();}
await writeFile(join(destination,'BACKUP-INTEGRITY.json'),JSON.stringify({private:true,containsCredentials:true,createdAt:new Date().toISOString(),sourceFiles:entries.length,consistentDatabase:'orynt-consistent.sqlite',entries},null,2));
const archive=destination+'.zip';
execFileSync('/usr/bin/zip',['-q','-y','-r',archive,'.'],{cwd:destination,timeout:240_000});
execFileSync('/usr/bin/unzip',['-tq',archive],{timeout:120_000});
console.log(JSON.stringify({archive,sourceFiles:entries.length,allSourceFilesMatched:true,sqliteIntegrity:'ok',private:true},null,2));
