const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn,spawnSync} = require('node:child_process');
const pty = require('./node-pty');
const [mode, configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath,'utf8'));
const descriptorPath = path.join(config.runtimeDir,'windows-session.json');
const fingerprint = JSON.stringify({provider:config.provider?.fingerprint ?? 'official',reload:config.reloadToken,
  kind:config.kind,workspace:config.remotePath,workspaceMode:config.workspaceMode ?? 'sync',version:config.windowsAgent,nodeEgress:Boolean(config.nodeEgress),
  // Restarts mcp-only sessions launched with --disable-slash-commands once.
  ...(config.kind==='claude'&&config.workspaceMode==='mcp-only'?{slashCommands:true}:{})});

function save(value) {
  const temporary=descriptorPath+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600});fs.renameSync(temporary,descriptorPath);
}
function descriptor(){try{return JSON.parse(fs.readFileSync(descriptorPath,'utf8'));}catch{return null;}}
function connect(info) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port:info.port});
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('Windows session did not respond'));},5000);
    socket.once('connect',()=>{clearTimeout(timer);resolve(socket);});socket.once('error',error=>{clearTimeout(timer);reject(error);});
  });
}
function send(socket,value){socket.write(JSON.stringify(value)+'\n');}
function messages(socket,receive) {
  let buffer='';socket.setEncoding('utf8');
  socket.on('data',data=>{
    buffer+=data;if(buffer.length>2*1024*1024){socket.destroy();return;}
    for(let offset;(offset=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,offset);buffer=buffer.slice(offset+1);try{receive(JSON.parse(line));}catch{socket.destroy();return;}}
  });
}
async function daemon() {
  const token=crypto.randomBytes(32).toString('hex');
  const clients=new Set();let history='',terminal,monitor,ending=false;
  const server=net.createServer(socket=>{
    let authenticated=false;const timer=setTimeout(()=>socket.destroy(),5000);
    socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(timer);clients.delete(socket);});
    messages(socket,message=>{
      if(!authenticated){
        const supplied=Buffer.from(typeof message.token==='string'?message.token:'');const expected=Buffer.from(token);
        if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected)){socket.destroy();return;}
        clearTimeout(timer);authenticated=true;
      }
      if(message.type==='stop'){shutdown();return;}
      if(message.type==='attach'){
        clients.add(socket);send(socket,{type:'output',data:'\x1bc'+history});send(socket,{type:'ready'});
      }else if(message.type==='input'&&terminal&&typeof message.data==='string'&&message.data.length<=1024*1024){terminal.write(message.data);}
      if((message.type==='resize'||message.type==='attach')&&terminal&&Number.isInteger(message.cols)&&Number.isInteger(message.rows)){
        terminal.resize(Math.max(20,Math.min(500,message.cols)),Math.max(5,Math.min(200,message.rows)));
      }
    });
  });
  function output(data){history=(history+data).slice(-512000);for(const socket of clients){if(socket.writableLength>4*1024*1024)socket.destroy();else send(socket,{type:'output',data});}}
  function shutdown(){if(ending)return;ending=true;try{terminal?.kill();}catch{}monitor?.kill();for(const socket of clients)socket.destroy();server.close();
    if(descriptor()?.pid===process.pid)try{fs.unlinkSync(descriptorPath);}catch{}setTimeout(()=>process.exit(0),150).unref();}
  server.listen(0,'127.0.0.1',()=>{
    try {
      terminal=pty.spawn(config.pythonExecutable,[config.helperPath,'run',configPath],{name:'xterm-256color',cols:100,rows:32,
        cwd:config.remotePath,env:{...process.env,PYTHONIOENCODING:'utf-8',TERM:'xterm-256color'},useConpty:true,useConptyDll:false});
      terminal.onData(output);terminal.onExit(({exitCode})=>{terminal=undefined;if(!ending&&descriptor()?.pid===process.pid)save({...descriptor(),phase:'exited',exitCode});output('\r\n[HappyPanda] Process exited ('+exitCode+').\r\n');});
      save({pid:process.pid,port:server.address().port,token,fingerprint,phase:'running',terminalPid:terminal.pid});
      monitor=spawn(config.pythonExecutable,[config.helperPath,'monitor',configPath],{stdio:'ignore',windowsHide:true});
      monitor.on('error',()=>{});
    }catch(error){output('[HappyPanda] '+error.message+'\r\n');shutdown();}
  });
  server.on('error',error=>{process.stderr.write(error.message+'\n');shutdown();});
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
async function attach() {
  let info=descriptor(),socket;
  if(info){try{socket=await connect(info);}catch{info=null;}}
  if(info&&info.fingerprint!==fingerprint){send(socket,{type:'stop',token:info.token});socket.destroy();socket=null;
    for(let attempt=0;attempt<100&&descriptor()?.pid===info.pid;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
  }
  if(!socket){
    const started=spawnSync(config.pythonExecutable,[config.helperPath,'windows-daemon',configPath],{windowsHide:true,encoding:'utf8'});
    if(started.error||started.status!==0)throw new Error(started.error?.message||started.stderr||'Windows session supervisor could not start');
    for(let attempt=0;attempt<200;attempt++){
      info=descriptor();
      if(info&&info.fingerprint===fingerprint){try{socket=await connect(info);break;}catch{}}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  if(!socket||!info){let detail='';try{detail=fs.readFileSync(path.join(config.runtimeDir,'windows-agent.log'),'utf8').slice(-4000);}catch{}throw new Error('Windows terminal could not start'+(detail?': '+detail:''));}
  messages(socket,message=>{
    if(message.type==='output'&&typeof message.data==='string')process.stdout.write(message.data);
    if(message.type==='ready')process.stdout.write('\x1b]777;happypanda-ready\x07');
  });
  socket.on('error',()=>{process.exitCode=1;});socket.on('close',()=>{process.stdin.pause();if(process.stdin.isTTY)try{process.stdin.setRawMode(false);}catch{}});
  const resize=()=>send(socket,{type:'resize',cols:process.stdout.columns??100,rows:process.stdout.rows??32});
  send(socket,{type:'attach',token:info.token,cols:process.stdout.columns??100,rows:process.stdout.rows??32});
  if(process.stdin.isTTY)process.stdin.setRawMode(true);
  process.stdin.on('data',data=>send(socket,{type:'input',data:data.toString('utf8')}));process.stdin.resume();
  process.stdin.on('end',()=>socket.end());process.stdout.on('resize',resize);
}
async function stop(){const info=descriptor();if(info){try{const socket=await connect(info);send(socket,{type:'stop',token:info.token});socket.end();}catch{}}}
(mode==='daemon'?daemon():mode==='attach'?attach():mode==='stop'?stop():Promise.reject(new Error('Invalid Windows terminal operation')))
  .catch(error=>{process.stderr.write('[HappyPanda] '+error.message+'\n');process.exitCode=1;});
