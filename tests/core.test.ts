import { describe,it,expect } from 'vitest';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStore } from '../src/main/store';
import { shellQuote,sshArgs } from '../src/main/ssh';

describe('node inventory and SSH boundaries',()=>{
  it('starts with no personal nodes, workspaces or sessions',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'happypanda-store-'));
    const store=new InventoryStore(dir);await store.load();
    expect(store.nodes).toEqual([]);
    expect(store.workspaces).toEqual([]);
    expect(store.sessions).toEqual([]);
    await store.save();
    const second=new InventoryStore(dir);await second.load();
    expect(second.nodes).toEqual([]);
  });
  it('preserves existing user inventory when loading',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'happypanda-store-'));
    const node={id:'saved-node',name:'Saved server',sshTarget:'saved-host',createdAt:'',lastWorkspaceId:'workspace',lastSessionId:'session'};
    const workspace={id:'workspace',nodeId:node.id,name:'Project',localPath:'local-project',remotePath:'/project',localAccess:false,syncSessionName:'sync-test',createdAt:''};
    const session={id:'session',nodeId:node.id,workspaceId:workspace.id,title:'Saved session',tmuxName:'hp-session',createdAt:'',lastActiveAt:'',kind:'claude'};
    const inventory={nodes:[node],workspaces:[workspace],sessions:[session]};
    const original=JSON.stringify(inventory);
    await writeFile(join(dir,'inventory.json'),original);
    const store=new InventoryStore(dir);await store.load();
    expect({nodes:store.nodes,workspaces:store.workspaces,sessions:store.sessions}).toEqual(inventory);
    expect(await readFile(join(dir,'inventory.json'),'utf8')).toBe(original);
  });
  it('rejects SSH argument injection and persists node identity',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'happypanda-store-'));
    const store=new InventoryStore(dir);await store.load();
    await expect(store.saveNode({name:'unsafe',sshTarget:'-oProxyCommand=bad'})).rejects.toThrow();
    const node=await store.saveNode({name:'Personal VPS',sshTarget:'my-node',port:2222});
    const second=new InventoryStore(dir);await second.load();
    expect(second.node(node.id).port).toBe(2222);
    expect(JSON.parse(await readFile(join(dir,'inventory.json'),'utf8')).nodes).toHaveLength(1);
  });
  it('quotes POSIX command parameters and applies configured SSH options',()=>{
    expect(shellQuote("a'b $(id)")).toBe("'a'\"'\"'b $(id)'");
    expect(sshArgs({id:'n',name:'n',sshTarget:'host',createdAt:'',port:2222,user:'ubuntu'})).toContain('StrictHostKeyChecking=yes');
  });
});
