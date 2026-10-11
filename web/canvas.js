/* Dependency-free, pointer-first, non-destructive screenshot annotation engine.
 * All annotations use normalized coordinates, so exporting at original resolution is lossless
 * relative to the uploaded bitmap (PNG bytes are not re-encoded until flattened export).
 */
import {normalizeStep, nextAnnotation} from './timeline.js';
const imageCache = new Map();
const clamp = (v) => Math.min(1, Math.max(0, v));
const clone = (value) => JSON.parse(JSON.stringify(value));

export async function getImage(src) {
  if (!src) return null;
  if (imageCache.has(src)) return imageCache.get(src);
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法加载截图'));
    img.src = src;
  });
  imageCache.set(src, promise);
  return promise;
}

function rectInfo(o) {
  const x = Math.min(o.x, o.x + (o.w || 0)), y = Math.min(o.y, o.y + (o.h || 0));
  return { x, y, w: Math.abs(o.w || 0), h: Math.abs(o.h || 0) };
}

function drawMosaic(ctx, image, o, W, H) {
  if (!image) return;
  const r = rectInfo(o);
  const x = Math.round(r.x * W), y = Math.round(r.y * H);
  const w = Math.min(W - x, Math.round(r.w * W)), h = Math.min(H - y, Math.round(r.h * H));
  if (w <= 0 || h <= 0) return;
  // Always sample from the source bitmap and flatten the result. This is not reversible.
  const block = Math.max(12, Math.round(Math.min(W, H) * 0.028));
  const sw = Math.max(1, Math.ceil(w / block)), sh = Math.max(1, Math.ceil(h / block));
  const reduced = document.createElement('canvas');
  reduced.width = sw; reduced.height = sh;
  const rctx = reduced.getContext('2d', {willReadFrequently: true});
  rctx.imageSmoothingEnabled = true;
  rctx.drawImage(image, (x / W) * image.naturalWidth, (y / H) * image.naturalHeight,
    (w / W) * image.naturalWidth, (h / H) * image.naturalHeight, 0, 0, sw, sh);
  ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(reduced, x, y, w, h); ctx.restore();
}

export function drawPrivacyMasks(ctx, image, annotations, W, H) {
  for (const o of annotations) {
    if (o.type === 'mask') drawAnnotation(ctx, o, W, H);
    else if (o.type === 'mosaic') drawMosaic(ctx, image, o, W, H);
  }
}

export function drawAnnotation(ctx, o, W, H) {
  const unit = Math.min(W, H), line = Math.max(2, (o.width || 0.006) * unit);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = o.color || '#E5484D'; ctx.fillStyle = o.color || '#E5484D'; ctx.lineWidth = line;
  if (['rect', 'circle', 'mask', 'mosaic'].includes(o.type)) {
    const r = rectInfo(o), x = r.x * W, y = r.y * H, w = r.w * W, h = r.h * H;
    if (o.type === 'rect') ctx.strokeRect(x, y, w, h);
    if (o.type === 'circle') { ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2); ctx.stroke(); }
    if (o.type === 'mask') { ctx.fillStyle = '#243044'; ctx.fillRect(x, y, w, h); }
  } else if (o.type === 'arrow') {
    const x = o.x * W, y = o.y * H, x2 = o.x2 * W, y2 = o.y2 * H;
    const angle = Math.atan2(y2 - y, x2 - x), head = Math.max(13, line * 5);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(angle - Math.PI / 6) * head, y2 - Math.sin(angle - Math.PI / 6) * head);
    ctx.lineTo(x2 - Math.cos(angle + Math.PI / 6) * head, y2 - Math.sin(angle + Math.PI / 6) * head);
    ctx.closePath(); ctx.fill();
  } else if (o.type === 'pen' || o.type === 'highlighter') {
    if (o.points?.length) {
      if (o.type === 'highlighter') { ctx.globalAlpha = 0.32; ctx.lineWidth = Math.max(7, (o.width || 0.033) * unit); }
      ctx.beginPath();
      o.points.forEach(([x, y], i) => i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H));
      ctx.stroke();
    }
  } else if (o.type === 'text') {
    ctx.font = `600 ${Math.max(14, (o.fontSize || 0.037) * unit)}px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif`;
    ctx.textBaseline = 'top';
    (o.text || '').split('\n').slice(0, 12).forEach((row, i) => ctx.fillText(row, o.x * W, o.y * H + i * unit * (o.fontSize || 0.037) * 1.3));
  } else if (o.type === 'number') {
    const radius = Math.max(14, unit * 0.036), x = o.x * W, y = o.y * H;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `700 ${radius * 1.15}px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(o.text || '1'), x, y + 1);
  }
  ctx.restore();
}

function drawScene(ctx, image, annotations, W, H, selected = -1, showSelection = false) {
  ctx.clearRect(0, 0, W, H);
  if (!image) return;
  ctx.drawImage(image, 0, 0, W, H);
  annotations.forEach(a => a.type === 'mosaic' ? drawMosaic(ctx, image, a, W, H) : drawAnnotation(ctx, a, W, H));
  if (showSelection && selected >= 0 && annotations[selected]) {
    const o = annotations[selected], box = bounds(o), x = box.x * W, y = box.y * H, w = box.w * W, h = box.h * H;
    ctx.save(); ctx.setLineDash([7, 5]); ctx.strokeStyle = '#4961b0'; ctx.lineWidth = Math.max(2, Math.min(W, H) * .002);
    ctx.strokeRect(x - 5, y - 5, Math.max(w, 15) + 10, Math.max(h, 15) + 10);
    ctx.setLineDash([]);
    if (['rect', 'circle', 'mask', 'mosaic'].includes(o.type)) {
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#4961b0'; ctx.fillRect(x + w - 6, y + h - 6, 12, 12); ctx.strokeRect(x + w - 6, y + h - 6, 12, 12);
    }
    ctx.restore();
  }
}

function bounds(o) {
  if (['rect', 'circle', 'mask', 'mosaic'].includes(o.type)) return rectInfo(o);
  if (o.type === 'arrow') return { x: Math.min(o.x, o.x2), y: Math.min(o.y, o.y2), w: Math.abs(o.x2 - o.x), h: Math.abs(o.y2 - o.y) };
  if (o.type === 'pen' || o.type === 'highlighter') {
    const xs = (o.points || []).map(p => p[0]), ys = (o.points || []).map(p => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return { x: o.x, y: o.y, w: o.type === 'text' ? .26 : .045, h: o.type === 'text' ? .075 : .045 };
}

function hitTest(annotations, point) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const r = bounds(annotations[i]), pad = .018;
    if (point.x >= r.x - pad && point.x <= r.x + r.w + pad && point.y >= r.y - pad && point.y <= r.y + r.h + pad) return i;
  }
  return -1;
}

export async function drawScenePreview(canvas,step,maxWidth=480) {
  const image=await getImage(step.imageData||step.imageUrl);
  if(!image)return;
  const scale=Math.min(1,maxWidth/image.naturalWidth);
  canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
  canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
  drawScene(canvas.getContext('2d'),image,step.annotations||[],canvas.width,canvas.height);
}

export async function exportStep(step) {
  const src = step.imageData || step.imageUrl;
  const image = await getImage(src);
  if (!image) throw new Error('当前步骤没有截图');
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  drawScene(canvas.getContext('2d'), image, step.annotations || [], canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片导出失败')), 'image/png'));
}

export class AnnotationCanvas {
  constructor(canvas, notify, requestText, onOperation = () => {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.notify = notify;
    this.requestText = requestText;
    this.onOperation = onOperation;
    this.step = null;
    this.image = null;
    this.tool = 'select';
    this.color = '#E5484D';
    this.selected = -1;
    this.drag = null;
    this.history = [];
    this.future = [];
    this.width = 0.006;
    this.pointerMap = new Map();
    this.pinch = null;
    this.suppressUntilEmpty = false;
    this.pendingText = null;
    this.viewport = {scale:1, tx:0, ty:0};
    this.canvas.addEventListener('pointerdown', e => this.down(e));
    this.canvas.addEventListener('pointermove', e => this.move(e));
    this.canvas.addEventListener('pointerup', e => this.up(e));
    this.canvas.addEventListener('pointercancel', e => this.up(e, true));
    this.canvas.addEventListener('dblclick', e => this.editExistingText(e));
  }
  async setStep(step) {
    normalizeStep(step);
    this.step = step; this.selected = -1; this.history = []; this.future = [];
    this.pointerMap.clear(); this.pinch = null; this.pendingText = null; this.drag = null;
    this.suppressUntilEmpty = false; this.resetViewport();
    this.image = null;
    this.draw();
    const current = step;
    try {
      const image = await getImage(step.imageData || step.imageUrl);
      if (current !== this.step) return;
      this.image = image;
      const scale = Math.min(1, 1400 / image.naturalWidth, 1800 / image.naturalHeight);
      this.canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      this.canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      this.canvas.style.width = '100%'; this.canvas.style.maxWidth = `${this.canvas.width}px`;
      this.draw();
    } catch (error) { this.image = null; this.draw(); }
  }
  setTool(tool) { this.tool = tool; this.selected = -1; this.draw(); }
  setColor(color) { this.color = color; }
  setWidth(width) { this.width = Math.max(.003, Math.min(.05, Number(width) || .006)); }
  applyViewport() {
    const parent = this.canvas.parentElement;
    if (parent) parent.style.transform = `translate(${this.viewport.tx}px, ${this.viewport.ty}px) scale(${this.viewport.scale})`;
  }
  resetViewport() { this.viewport = {scale:1,tx:0,ty:0}; this.applyViewport(); }
  cancelUncommittedDrag() {
    if (!this.drag) return;
    if (this.history.length) this.step.annotations = this.history.pop();
    this.drag = null; this.selected = -1; this.draw();
  }
  startPinch() {
    this.cancelUncommittedDrag(); this.pendingText = null;
    this.suppressUntilEmpty = true;
    const pts = [...this.pointerMap.values()].slice(0,2);
    const midpoint = {x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};
    const distance = Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);
    this.pinch = {distance:Math.max(1,distance), midpoint, ...this.viewport, rect:this.canvas.getBoundingClientRect()};
  }
  updatePinch() {
    if (!this.pinch || this.pointerMap.size < 2) return;
    const pts = [...this.pointerMap.values()].slice(0,2), initial = this.pinch;
    const distance = Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);
    const center = {x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2};
    const scale = Math.max(1, Math.min(5, initial.scale * distance / initial.distance));
    const ratio = scale / initial.scale;
    this.viewport = {scale,
      tx:initial.tx + center.x - initial.midpoint.x + (initial.midpoint.x-initial.rect.left)*(1-ratio),
      ty:initial.ty + center.y - initial.midpoint.y + (initial.midpoint.y-initial.rect.top)*(1-ratio)};
    this.applyViewport();
  }
  async requestTextAt(p) {
    const step = this.step, list = step?.annotations;
    if (!step || !list) return;
    const type = this.tool;
    const content = await this.requestText(type === 'number' ? '输入步骤序号' : '输入标注文字',
      type === 'number' ? String(list.filter(o => o.type === 'number').length + 1) : '');
    if (content?.trim() && this.step === step && this.pointerMap.size === 0) {
      this.snapshot(); const item=nextAnnotation(step,{type,x:p.x,y:p.y,text:content.trim(),color:this.color,fontSize:.037});
      list.push(item); this.selected=list.length-1; this.draw(); this.notify();
      this.onOperation({action:'annotation.add',objectId:item.id,after:clone(item)});
    }
  }
  point(e) {
    const b = this.canvas.getBoundingClientRect();
    return { x: clamp((e.clientX - b.left) / b.width), y: clamp((e.clientY - b.top) / b.height) };
  }
  snapshot() { if (this.step) { this.history.push(clone(this.step.annotations || [])); if (this.history.length > 35) this.history.shift(); this.future = []; } }
  undo() { if (!this.step || !this.history.length) return; const before=clone(this.step.annotations); this.future.push(before); this.step.annotations = this.history.pop(); this.selected = -1; this.draw(); this.notify(); this.onOperation({action:'undo',before,after:clone(this.step.annotations)}); }
  redo() { if (!this.step || !this.future.length) return; const before=clone(this.step.annotations); this.history.push(before); this.step.annotations = this.future.pop(); this.selected = -1; this.draw(); this.notify(); this.onOperation({action:'redo',before,after:clone(this.step.annotations)}); }
  deleteSelected() { if (!this.step || this.selected < 0) return; const before=clone(this.step.annotations[this.selected]); this.snapshot(); this.step.annotations.splice(this.selected, 1); this.selected = -1; this.draw(); this.notify(); this.onOperation({action:'annotation.delete',objectId:before.id,before}); }
  draw() { if (!this.canvas.width) { this.canvas.width = 480; this.canvas.height = 320; } drawScene(this.ctx, this.image, this.step?.annotations || [], this.canvas.width, this.canvas.height, this.selected, true); }
  down(e) {
    if (!this.step || !this.image) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.pointerMap.set(e.pointerId, {x:e.clientX,y:e.clientY});
    if (this.pointerMap.size >= 2) { this.startPinch(); e.preventDefault(); return; }
    if (this.suppressUntilEmpty) return;
    const p = this.point(e), list = this.step.annotations;
    if (this.tool === 'text' || this.tool === 'number') {
      // Only open a text dialog after a complete single-finger tap.
      this.pendingText = {pointerId:e.pointerId, p, screen:{x:e.clientX,y:e.clientY}};
      return;
    }
    if (this.tool === 'select') {
      this.selected = hitTest(list,p);
      if (this.selected !== -1) {
        this.snapshot(); const selected=list[this.selected], r=bounds(selected);
        const resize=['rect','circle','mask','mosaic'].includes(selected.type) && Math.abs(p.x-r.x-r.w)<.035 && Math.abs(p.y-r.y-r.h)<.035;
        this.drag={mode:resize?'resize':'move',start:p,original:clone(selected),index:this.selected,changed:false,startedAt:performance.now(),pointerId:e.pointerId};
      } else if (this.viewport.scale > 1) {
        this.drag={mode:'pan',screen:{x:e.clientX,y:e.clientY},originalViewport:{...this.viewport},changed:false,pointerId:e.pointerId};
      } else this.drag=null;
      this.draw();
      if (this.drag) this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    this.snapshot();
    const item=nextAnnotation(this.step,{type:this.tool,color:this.color,width:this.tool==='highlighter'?Math.max(.025,this.width):this.width,x:p.x,y:p.y});
    if (['rect','circle','mask','mosaic'].includes(this.tool)) Object.assign(item,{w:0,h:0});
    else if (this.tool==='arrow') Object.assign(item,{x2:p.x,y2:p.y});
    else if (['pen','highlighter'].includes(this.tool)) {item.points=[[p.x,p.y]];item.strokeSamples=[[p.x,p.y,0]];}
    list.push(item);this.selected=list.length-1;
    this.drag={mode:'draw',index:this.selected,start:p,changed:false,startedAt:performance.now(),pointerId:e.pointerId};
    this.canvas.setPointerCapture(e.pointerId);this.draw();
  }
  move(e) {
    if (this.pointerMap.has(e.pointerId)) this.pointerMap.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if (this.pointerMap.size>=2) {this.updatePinch();e.preventDefault();return;}
    if (this.suppressUntilEmpty || !this.step) return;
    if (this.pendingText?.pointerId===e.pointerId) {
      if (Math.hypot(e.clientX-this.pendingText.screen.x,e.clientY-this.pendingText.screen.y)>9)this.pendingText=null;
      return;
    }
    if (!this.drag || this.drag.pointerId!==e.pointerId) return;
    const d=this.drag;
    if (d.mode==='pan') {
      this.viewport.tx=d.originalViewport.tx+e.clientX-d.screen.x;
      this.viewport.ty=d.originalViewport.ty+e.clientY-d.screen.y;
      this.applyViewport();d.changed=true;return;
    }
    const p=this.point(e),o=this.step.annotations[d.index];if(!o)return;
    const dx=p.x-d.start.x,dy=p.y-d.start.y;
    if(Math.abs(dx)>.001||Math.abs(dy)>.001)d.changed=true;
    if(d.mode==='draw'){
      if(['rect','circle','mask','mosaic'].includes(o.type)){o.w=dx;o.h=dy;}
      if(o.type==='arrow'){o.x2=p.x;o.y2=p.y;}
      if(['pen','highlighter'].includes(o.type)&&o.points.length<4000){const last=o.points.at(-1);if(Math.hypot(last[0]-p.x,last[1]-p.y)>.002){o.points.push([p.x,p.y]);o.strokeSamples.push([p.x,p.y,Math.round(performance.now()-d.startedAt)]);}}
    }else if(d.mode==='resize'){
      o.x=d.original.x;o.y=d.original.y;o.w=d.original.w+dx;o.h=d.original.h+dy;
    }else{
      const orig=d.original;o.x=clamp(orig.x+dx);o.y=clamp(orig.y+dy);
      if(o.type==='arrow'){o.x2=clamp(orig.x2+dx);o.y2=clamp(orig.y2+dy);}
      if(['pen','highlighter'].includes(o.type))o.points=orig.points.map(([x,y])=>[clamp(x+dx),clamp(y+dy)]);
    }
    this.draw();
  }
  up(e,cancelled=false) {
    this.pointerMap.delete(e.pointerId);
    if(this.pinch || this.suppressUntilEmpty){
      if(!this.pointerMap.size){this.pinch=null;this.suppressUntilEmpty=false;}
      return;
    }
    if(this.pendingText?.pointerId===e.pointerId){
      const p=this.pendingText.p;this.pendingText=null;
      if(!cancelled)this.requestTextAt(p);
      return;
    }
    if(!this.drag || this.drag.pointerId!==e.pointerId)return;
    const d=this.drag;this.drag=null;
    if(this.canvas.hasPointerCapture(e.pointerId))this.canvas.releasePointerCapture(e.pointerId);
    if(d.mode==='pan')return;
    if(cancelled){this.step.annotations=this.history.pop();this.draw();return;}
    if(!d.changed){
      if(d.mode==='draw')this.step.annotations.splice(d.index,1);
      this.history.pop();
    }else{
      this.notify();const after=clone(this.step.annotations[d.index]);
      if(after)this.onOperation({action:d.mode==='draw'?'annotation.add':'annotation.update',objectId:after.id,before:d.mode==='draw'?null:d.original,after,gestureDurationMs:performance.now()-d.startedAt});
    }
    this.draw();
  }
  async editExistingText(e) {
    const p = this.point(e), index = hitTest(this.step?.annotations || [], p);
    const obj = this.step?.annotations?.[index];
    if (obj && ['number', 'text'].includes(obj.type)) {
      const content = await this.requestText('修改标注', obj.text);
      if (content !== null && content.trim() && this.step?.annotations?.includes(obj)) { const before=clone(obj); this.snapshot(); obj.text = content.trim(); this.selected = index; this.draw(); this.notify(); this.onOperation({action:'annotation.update',objectId:obj.id,before,after:clone(obj)}); }
    }
  }
}
