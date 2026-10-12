import {describe,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {projectMemorySnapshot} from '../src/main/memory';

describe('project memory snapshots',()=>{
  it('maps the local project to Markdown memory files without reading history or credentials',async()=>{
    const base=await mkdtemp(path.join(tmpdir(),'hp-memory-'));
    try{
      const project=path.join(base,'project'),config=path.join(base,'claude');await mkdir(project);
      const root=await realpath(project),memory=path.join(config,'projects',root.replace(/[^a-zA-Z0-9]/g,'-'),'memory');
      await mkdir(path.join(memory,'topics'),{recursive:true});
      await writeFile(path.join(memory,'MEMORY.md'),'[Topic](topics/project.md)\n');await writeFile(path.join(memory,'topics','project.md'),'Synthetic project note.\n');
      await writeFile(path.join(memory,'ignored.json'),'not a memory');await writeFile(path.join(config,'credentials.json'),'synthetic-credential');
      const snapshot=await projectMemorySnapshot(project,config);
      expect(snapshot.files.map(file=>file.path).sort()).toEqual(['MEMORY.md','topics/project.md']);
      for(const file of snapshot.files){const bytes=Buffer.from(file.content,'base64');expect(file.bytes).toBe(bytes.length);expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));}
      expect(JSON.stringify(snapshot)).not.toContain('synthetic-credential');
    }finally{
      const target=await realpath(base),temporary=await realpath(tmpdir()),relative=path.relative(temporary,target);
      if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(target).startsWith('hp-memory-'))await rm(target,{recursive:true});
    }
  });
});
