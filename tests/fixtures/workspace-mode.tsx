import '@vitejs/plugin-react/preamble';
import {createRoot} from 'react-dom/client';
import App from '../../src/renderer/src/App';
import '@xterm/xterm/css/xterm.css';
import '../../src/renderer/src/styles.css';
import '../../src/renderer/src/remote.css';
import {emptySync,type AppEvent,type AppState,type HappyPandaAPI} from '../../src/shared/types';

const workspace={id:'fixture-workspace',nodeId:'fixture-node',name:'Local Workspace',localPath:'C:/Projects/local-workspace',remotePath:'/home/fixture/.local/share/happypanda/workspaces/fixture',localAccess:true,mode:'mcp-only' as const,syncSessionName:'hp-fixture',createdAt:''};
const state:AppState={version:'fixture',nodes:[{id:'fixture-node',name:'Cloud Claude',sshTarget:'fixture.invalid',createdAt:''}],providers:[],workspaces:[workspace],sessions:[],
  connection:{phase:'connected',message:'',retryAttempt:0,activeNodeId:'fixture-node',activeWorkspaceId:workspace.id,activeSessionId:'fixture-session'},
  metrics:null,sync:emptySync(),activities:[],terminalBuffer:'HappyPanda local workspace\r\n',terminalGeneration:1};
const listeners=new Set<(event:AppEvent)=>void>();
const publish=()=>{for(const listener of listeners)listener({type:'state',state:structuredClone(state)});};
const api:Partial<HappyPandaAPI>={
  getState:async()=>structuredClone(state),listSshAliases:async()=>[],
  setWorkspaceMode:async(id,mode)=>{const value=state.workspaces.find(item=>item.id===id)!;value.mode=mode;if(mode==='mcp-only')value.localAccess=true;state.sync=mode==='mcp-only'?emptySync():{...emptySync(),phase:'ready'};publish();},
  chooseWorkspace:async(_id,mode)=>{state.workspaces[0].mode=mode;publish();return state.workspaces[0];},
  connect:async()=>publish(),setLocalAccess:async(_id,enabled)=>{state.workspaces[0].localAccess=enabled;publish();},
  syncNow:async()=>state.sync,pauseSync:async()=>{},resizeTerminal:()=>{},writeTerminal:()=>{},
  onEvent:callback=>{listeners.add(callback);return()=>{listeners.delete(callback);};},
};
Object.defineProperty(window,'happyPanda',{value:api});
createRoot(document.getElementById('root')!).render(<App/>);
