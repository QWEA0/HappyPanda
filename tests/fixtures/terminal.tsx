import '@vitejs/plugin-react/preamble';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import '../../src/renderer/src/styles.css';
import { TerminalView } from '../../src/renderer/src/components/TerminalView';
import { emptySync,type AppState } from '../../src/shared/types';

const sample='\x1b[1;1H\x1b[1mWelcome to Claude Code\x1b[0m\r\n\r\nHappyPanda terminal font rendering test\r\nABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789\r\nabcdefghijklmnopqrstuvwxyz !@#$%^&*()\r\n\r\n\x1b[38;5;78mProject files synchronized\x1b[0m\r\n\x1b[38;5;208mAccount authentication pending\x1b[0m\r\n\r\nThin strokes, bold text, cursor and ASCII edges should remain distinct.\r\n';
const state:AppState={nodes:[],providers:[],workspaces:[],sessions:[],connection:{phase:'connected',message:'',retryAttempt:0,activeNodeId:'render-test',activeSessionId:'render-test'},metrics:null,sync:emptySync(),activities:[],terminalBuffer:sample,version:'test'};
createRoot(document.getElementById('root')!).render(<div style={{height:'100%',display:'flex',background:'#191b1e'}}><TerminalView state={state} onError={(title,detail)=>console.error(title,detail)} onInfo={()=>{}}/></div>);
