/* Canvas-only tutorial animation: never expose an unmasked image to captured frames. */
import {getImage, drawAnnotation} from './canvas.js';
import {timelineForGuide} from './timeline.js';

export const VIDEO_WIDTH=540, VIDEO_HEIGHT=960;
const clamp=v=>Math.max(0,Math.min(1,v));
const label=(ctx,str,x,y,maxW)=>{ctx.fillText(str,x,y,maxW);};

export async function prepareVideo(guide) {
  const timeline=timelineForGuide(guide);
  const images=await Promise.all(timeline.entries.map(e=>getImage(e.step.imageData||e.step.imageUrl)));
  if (!timeline.entries.length || images.some(x=>!x)) throw new Error('请先为教程添加至少一张有效截图');
  return {...timeline,images,guide};
}

function reveal(ctx,o,w,h,progress){
  if(progress<=0)return;
  if(o.type==='arrow' && progress<1){
    const t={...o,x2:o.x+(o.x2-o.x)*progress,y2:o.y+(o.y2-o.y)*progress};
    drawAnnotation(ctx,t,w,h);return;
  }
  if(o.type==='pen' && progress<1){
    const points=o.points||[];
    const length=Math.max(2,Math.ceil(points.length*progress));
    drawAnnotation(ctx,{...o,points:points.slice(0,length)},w,h);return;
  }
  if(o.type==='circle' && progress<1){
    const x=Math.min(o.x,o.x+(o.w||0))*w, y=Math.min(o.y,o.y+(o.h||0))*h;
    const rw=Math.abs(o.w||0)*w, rh=Math.abs(o.h||0)*h;
    ctx.save();ctx.strokeStyle=o.color||'#E5484D';ctx.lineWidth=Math.max(2,(o.width||.006)*Math.min(w,h));
    ctx.lineCap='round';ctx.beginPath();ctx.ellipse(x+rw/2,y+rh/2,Math.max(.01,rw/2),Math.max(.01,rh/2),0,-Math.PI/2,-Math.PI/2+2*Math.PI*progress);ctx.stroke();ctx.restore();return;
  }
  ctx.save();ctx.globalAlpha=progress;drawAnnotation(ctx,o,w,h);ctx.restore();
}

export function renderVideoFrame(canvas, prepared, timeMs){
  const W=canvas.width||VIDEO_WIDTH,H=canvas.height||VIDEO_HEIGHT;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,W,H);ctx.fillStyle='#F7F8FA';ctx.fillRect(0,0,W,H);
  if(!prepared.entries.length)return;
  const t=Math.min(Math.max(timeMs,0),Math.max(0,prepared.totalMs-1));
  const idx=Math.max(0,prepared.entries.findIndex(e=>t>=e.atMs&&t<e.atMs+e.durationMs));
  const entry=prepared.entries[idx], img=prepared.images[idx], local=t-entry.atMs;
  ctx.fillStyle='#232F45';ctx.font=`600 ${W*.036}px sans-serif`;
  label(ctx,String(prepared.guide.title||'操作教程').slice(0,24),W*.07,H*.085,W*.86);
  ctx.fillStyle='#7B8799';ctx.font=`500 ${W*.022}px sans-serif`;
  label(ctx,`STEP ${String(idx+1).padStart(2,'0')}  /  ${String(prepared.entries.length).padStart(2,'0')}`,W*.07,H*.125,W*.86);
  const limitW=W*.88,limitH=H*.68, scale=Math.min(limitW/img.naturalWidth,limitH/img.naturalHeight);
  const iw=img.naturalWidth*scale,ih=img.naturalHeight*scale,x=(W-iw)/2,y=H*.48-ih/2;
  ctx.save();ctx.shadowColor='rgba(33,48,70,.11)';ctx.shadowBlur=20;ctx.shadowOffsetY=6;
  ctx.fillStyle='#fff';ctx.fillRect(x-3,y-3,iw+6,ih+6);ctx.restore();
  ctx.save();ctx.translate(x,y);
  ctx.drawImage(img,0,0,iw,ih);
  // Critical: apply all privacy masks before capturing/presenting each complete frame.
  const anns=entry.step.annotations||[];
  anns.filter(o=>o.type==='mask').forEach(o=>drawAnnotation(ctx,o,iw,ih));
  const cueMap=new Map(entry.presentation.cues.map(c=>[c.objectId,c]));
  anns.filter(o=>o.type!=='mask').forEach(o=>{
    const cue=cueMap.get(o.id);if(!cue)return;
    reveal(ctx,o,iw,ih,clamp((local-cue.atMs)/Math.max(cue.durationMs,1)));
  });
  ctx.restore();
  ctx.fillStyle='#25334B';ctx.font=`500 ${W*.03}px sans-serif`;
  const subtitle=(entry.presentation.subtitle||'').slice(0,92);
  // Wrap CJK/Latin at actual canvas width, never overflow the video edge.
  let line='',rows=[];
  for(const char of subtitle){if(ctx.measureText(line+char).width>W*.85&&line){rows.push(line);line='';}line+=char;}
  if(line)rows.push(line);
  rows.slice(0,3).forEach((v,i)=>label(ctx,v,W*.07,H*.88+i*W*.049,W*.86));
  ctx.fillStyle='#D7DDE6';ctx.fillRect(W*.07,H*.956,W*.86,3);
  ctx.fillStyle='#5876B4';ctx.fillRect(W*.07,H*.956,W*.86*clamp(t/Math.max(1,prepared.totalMs)),3);
}

export function chooseMimeType(){
  if(typeof MediaRecorder==='undefined')return '';
  return ['video/mp4;codecs=avc1.42E01E','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(t=>MediaRecorder.isTypeSupported(t))||'';
}

// This is a realtime local recording, not a guaranteed MP4 generator.
export async function recordVideo(canvas,prepared,onProgress=()=>{}){
  const mimeType=chooseMimeType();
  if(!canvas.captureStream||!mimeType)throw new Error('当前浏览器不支持本地视频编码。请用桌面 Chrome/Edge 试试，图文教程仍可正常导出。');
  const stream=canvas.captureStream(30);
  const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:2500000});
  const chunks=[];let raf=0,finished=false;
  const result=new Promise((resolve,reject)=>{
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    recorder.onerror=e=>reject(e.error||new Error('视频录制发生错误'));
    recorder.onstop=()=>{stream.getTracks().forEach(track=>track.stop());
      const blob=new Blob(chunks,{type:mimeType});blob.size?resolve({blob,extension:mimeType.startsWith('video/mp4')?'mp4':'webm'}):reject(new Error('视频文件为空，请切换浏览器重试'));};
  });
  renderVideoFrame(canvas,prepared,0);
  try{recorder.start(250);}catch(error){stream.getTracks().forEach(t=>t.stop());throw error;}
  const start=performance.now();
  const tick=now=>{
    if(finished)return;
    const elapsed=Math.min(now-start,prepared.totalMs);
    renderVideoFrame(canvas,prepared,elapsed);
    onProgress(elapsed/prepared.totalMs);
    if(elapsed>=prepared.totalMs){finished=true;recorder.stop();return;}
    raf=requestAnimationFrame(tick);
  };
  raf=requestAnimationFrame(tick);
  try{return await result;}finally{finished=true;cancelAnimationFrame(raf);if(recorder.state!=='inactive')recorder.stop();stream.getTracks().forEach(t=>t.stop());}
}
