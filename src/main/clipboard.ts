import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Clipboard } from 'electron';
import type { ServiceNode } from '../shared/types';
import { runRemote, shellQuote } from './ssh';
export { terminalPaste } from '../shared/terminal';

export const MAX_CLIPBOARD_IMAGE_BYTES=20*1024*1024;
const MAX_IMAGE_PIXELS=40_000_000;
export type ClipboardContent={kind:'image';png:Buffer}|{kind:'text';text:string}|{kind:'empty'};

export async function writeClipboardText(clipboard:Pick<Clipboard,'writeText'>,text:unknown):Promise<void> {
  if(typeof text!=='string')throw new Error('无效的复制内容。');
  await clipboard.writeText(text);
}

export function validateClipboardPng(png:Buffer):void {
  if(png.length>MAX_CLIPBOARD_IMAGE_BYTES)throw new Error('剪贴板图片超过 20 MiB，请缩小图片后重试。');
  if(png.length<33||!png.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||png.readUInt32BE(8)!==13||png.toString('ascii',12,16)!=='IHDR')throw new Error('剪贴板图片不是有效的 PNG。');
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  if(!width||!height||width*height>MAX_IMAGE_PIXELS)throw new Error('剪贴板图片尺寸过大或无效，请缩小图片后重试。');
}

export async function readClipboardContent(clipboard:Pick<Clipboard,'read'>):Promise<ClipboardContent> {
  // Electron 44 exposes asynchronous ClipboardItems, including native screenshots as PNG.
  // Use one snapshot so a later clipboard change cannot replace the requested content.
  const items=await clipboard.read();
  const image=items.find(item=>item.types.includes('image/png'));
  if(image){
    const blob=await image.getType('image/png');
    if(blob.size>MAX_CLIPBOARD_IMAGE_BYTES)throw new Error('剪贴板图片超过 20 MiB，请缩小图片后重试。');
    const png=Buffer.from(await blob.arrayBuffer());validateClipboardPng(png);
    return {kind:'image',png};
  }
  if(items.some(item=>item.types.some(type=>type.startsWith('image/'))))throw new Error('剪贴板图片格式暂不支持，请截图后再粘贴。');
  const item=items.find(item=>item.types.includes('text/plain'));
  if(!item)return {kind:'empty'};
  const blob=await item.getType('text/plain');
  if(blob.size>4*1024*1024)throw new Error('剪贴板文字过长，请分段粘贴。');
  const text=await blob.text();
  if(text.length>1024*1024)throw new Error('剪贴板文字过长，请分段粘贴。');
  return text?{kind:'text',text}:{kind:'empty'};
}

export class ClipboardImageUploader {
  constructor(private resourcesDir:string,private remote:typeof runRemote=runRemote){}
  async upload(node:ServiceNode,sessionId:string,png:Buffer):Promise<string>{
    validateClipboardPng(png);
    const sha256=createHash('sha256').update(png).digest('hex');
    const sessionKey=createHash('sha256').update(node.id+'\0'+sessionId).digest('hex');
    const script=await readFile(join(this.resourcesDir,'upload_image.py'));
    const command='python3 -c '+shellQuote('import base64;exec(base64.b64decode('+JSON.stringify(script.toString('base64'))+'))')+' '+shellQuote(JSON.stringify({sessionKey,sha256,bytes:png.length}));
    // Image bytes travel only through encrypted SSH stdin, never command arguments.
    const output=JSON.parse(await this.remote(node,command,png,90000));
    const suffix='/.local/share/happypanda/attachments/'+sessionKey+'/'+sha256+'.png';
    if(typeof output.path!=='string'||(!posix.isAbsolute(output.path)&&!/^[A-Za-z]:\//.test(output.path))||posix.normalize(output.path)!==output.path||/[\x00-\x1f\x7f]/.test(output.path)||!output.path.endsWith(suffix)||output.sha256!==sha256||output.bytes!==png.length)throw new Error('图片上传校验失败，未写入终端。');
    return output.path;
  }
}
