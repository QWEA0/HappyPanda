import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {expect,it} from 'vitest';
import {InventoryStore} from '../src/main/store';

it('loads legacy workspaces as synchronized and persists MCP-only mode with required local access',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hp-mode-store-'));
  try{
    const workspace={id:'project',nodeId:'node',name:'Project',localPath:'C:/Project',remotePath:'/mirror',localAccess:false,syncSessionName:'hp-project',createdAt:''};
    await writeFile(join(directory,'inventory.json'),JSON.stringify({nodes:[],workspaces:[workspace],sessions:[]}));
    const legacy=new InventoryStore(directory);await legacy.load();expect(legacy.workspace('project').mode??'sync').toBe('sync');
    legacy.workspace('project').mode='mcp-only';await legacy.save();
    const restored=new InventoryStore(directory);await restored.load();
    expect(restored.workspace('project')).toMatchObject({mode:'mcp-only',localAccess:true});
    await restored.save();expect(JSON.parse(await readFile(join(directory,'inventory.json'),'utf8')).workspaces[0].mode).toBe('mcp-only');
  }finally{
    if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('hp-mode-store-'))throw new Error('Unsafe test cleanup');
    await rm(directory,{recursive:true,force:true});
  }
});
