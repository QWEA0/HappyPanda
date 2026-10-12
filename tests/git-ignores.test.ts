import { describe,it,expect } from 'vitest';
import { mkdtemp,mkdir,writeFile,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitIgnorePaths } from '../src/main/sync/git-ignores';
import { SYNC_IGNORES } from '../src/main/sync';
import { runCommand } from '../src/main/sync/transport';

describe('Git-derived sync exclusions',()=>{
  it('excludes ignored runtime data while preserving tracked files under ignored directories',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'hp-git-ignores-'));
    try{
      await runCommand('git',['-C',root,'init','-q']);
      await mkdir(path.join(root,'data','models'),{recursive:true});
      await mkdir(path.join(root,'reports [old]'));
      await writeFile(path.join(root,'.gitignore'),'data/\r\n.env\r\nreports*/\r\n__pycache__/\r\n\r\n');
      await writeFile(path.join(root,'data','models','weights.bin'),'synthetic-model');
      await writeFile(path.join(root,'data','keep.txt'),'tracked-source');
      await writeFile(path.join(root,'reports [old]','output.log'),'ignored-report');
      await writeFile(path.join(root,'.env'),'SYNTHETIC=1');
      await runCommand('git',['-C',root,'add','-f','data/keep.txt']);
      const ignores=await gitIgnorePaths(root,runCommand);
      expect(ignores).toContain('/.env');expect(ignores).toContain('/data/*');
      expect(ignores).not.toContain('/data/');expect(ignores).not.toContain('/data/keep.txt');
      expect(ignores).toContain('!/data/keep.txt');
      expect(ignores).toContain('/reports \\[old\\]/');
      await mkdir(path.join(root,'data','new-output'));
      await writeFile(path.join(root,'data','new-output','result.log'),'new ignored content');
      await rm(path.join(root,'data','models'),{recursive:true});
      expect(await gitIgnorePaths(root,runCommand)).toEqual(ignores);
      const beforeCache=await gitIgnorePaths(root,runCommand,SYNC_IGNORES);
      await mkdir(path.join(root,'another','__pycache__'),{recursive:true});
      await writeFile(path.join(root,'another','__pycache__','new.pyc'),'ignored cache');
      expect(await gitIgnorePaths(root,runCommand,SYNC_IGNORES)).toEqual(beforeCache);
      await writeFile(path.join(root,'another','source.py'),'untracked source remains eligible');
      expect(await gitIgnorePaths(root,runCommand,SYNC_IGNORES)).toEqual(beforeCache);
    }finally{
      const target=await realpath(root),base=await realpath(tmpdir()),child=path.relative(base,target);
      if(child&&!child.startsWith('..')&&!path.isAbsolute(child)&&path.basename(target).startsWith('hp-git-ignores-'))await rm(target,{recursive:true});
    }
  });
});
