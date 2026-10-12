import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe,expect,it,vi } from 'vitest';
import type { Clipboard } from 'electron';
import { ClipboardImageUploader,MAX_CLIPBOARD_IMAGE_BYTES,readClipboardContent,terminalPaste,validateClipboardPng } from '../src/main/clipboard';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=','base64');
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const node={id:'node',name:'test',sshTarget:'test-host',createdAt:''};
function clipboard(values:Record<string,Blob>):Pick<Clipboard,'read'>{
  return {read:vi.fn(async()=>[{types:Object.keys(values),getType:async(type:string)=>values[type]}] as any)};
}

describe('clipboard image and text input',()=>{
  it('reads Electron ClipboardItems and prefers a copied image over its accompanying URL',async()=>{
    const content=await readClipboardContent(clipboard({'text/plain':new Blob(['https://image.example/test.png']),'image/png':new Blob([new Uint8Array(png)])}));
    expect(content).toEqual({kind:'image',png});
  });
  it('preserves Unicode text and reports an empty clipboard',async()=>{
    expect(await readClipboardContent(clipboard({'text/plain':new Blob(['中文\r\ntext'])}))).toEqual({kind:'text',text:'中文\r\ntext'});
    expect(await readClipboardContent(clipboard({}))).toEqual({kind:'empty'});
  });
  it('rejects unsupported, invalid and oversized images instead of pasting their text representation',async()=>{
    await expect(readClipboardContent(clipboard({'image/svg+xml':new Blob(['<svg/>'])}))).rejects.toThrow('格式');
    expect(()=>validateClipboardPng(Buffer.from('not a PNG'))).toThrow('PNG');
    const oversized=Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES+1);
    expect(()=>validateClipboardPng(oversized)).toThrow('20 MiB');
    const hugeDimensions=Buffer.from(png);hugeDimensions.writeUInt32BE(100000,16);hugeDimensions.writeUInt32BE(100000,20);
    expect(()=>validateClipboardPng(hugeDimensions)).toThrow('尺寸');
  });
  it('normalizes text paste and cannot break out of its terminal paste bracket',()=>{
    expect(terminalPaste('a\r\nb\nc',true)).toBe('\x1b[200~a\rb\rc\x1b[201~');
    expect(terminalPaste('a\nb',false)).toBe('a\rb');
    expect(terminalPaste('x\x1b[201~\x03y',true)).toBe('\x1b[200~x[201~y\x1b[201~');
  });
});

describe('verified remote image upload',()=>{
  it('transports PNG bytes only in SSH stdin and accepts a verified session-scoped attachment',async()=>{
    const sessionId='session';
    const destination='/home/test/.local/share/happypanda/attachments/'+hash('node\0'+sessionId)+'/'+hash(png)+'.png';
    const remote=vi.fn(async()=>JSON.stringify({path:destination,bytes:png.length,sha256:hash(png)}));
    expect(await new ClipboardImageUploader(resolve('resources'),remote).upload(node,sessionId,png)).toBe(destination);
    const args=(remote.mock.calls as unknown[][])[0];
    expect(args[2]).toEqual(png);expect(args[1]).not.toContain(png.toString('base64'));
    expect(destination).not.toContain('/workspaces/');
  });
  it.each(['wrong checksum','wrong session','control characters'])('rejects a remote response with %s before terminal insertion',async(problem)=>{
    let destination='/home/test/.local/share/happypanda/attachments/'+hash('node\0session')+'/'+hash(png)+'.png';
    if(problem==='wrong session')destination=destination.replace(hash('node\0session'),hash('other session'));
    if(problem==='control characters')destination='/home/\x1b'+destination;
    const remote=vi.fn(async()=>JSON.stringify({path:destination,bytes:png.length,sha256:problem==='wrong checksum'?'0'.repeat(64):hash(png)}));
    await expect(new ClipboardImageUploader(resolve('resources'),remote).upload(node,'session',png)).rejects.toThrow('校验');
  });
});
