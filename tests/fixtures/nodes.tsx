import '@vitejs/plugin-react/preamble';
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/renderer/src/styles.css';
import '../../src/renderer/src/remote.css';
import {NodeDialog} from '../../src/renderer/src/components/NodeDialogs';
import type {HappyPandaAPI,ServiceNode} from '../../src/shared/types';
import type {RunAction} from '../../src/renderer/src/useAppState';

function Fixture(){
  const [node,setNode]=useState<ServiceNode>();
  const [open,setOpen]=useState(true);
  const run:RunAction=async(_key,_title,action)=>({ok:true,value:await action({saveNode:async input=>{
    const {password,...metadata}=input;
    const saved={...metadata,id:node?.id??'fixture',createdAt:'',hasPassword:input.authType==='password'&&Boolean(password||node?.hasPassword)};
    setNode(saved);return saved;
  }} as Pick<HappyPandaAPI,'saveNode'> as HappyPandaAPI)});
  return <div className="app-shell"><header className="toolbar"><button onClick={()=>setOpen(true)}>编辑节点</button></header>
    <output aria-label="节点状态">{node?JSON.stringify(node):'尚未保存'}</output>
    {open&&<NodeDialog node={node} aliases={[]} pending={new Set()} run={run} loadAliases={async()=>{}} onClose={()=>setOpen(false)}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
