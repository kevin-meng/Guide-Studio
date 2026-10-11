import test from 'node:test';
import assert from 'node:assert/strict';
import {AnnotationCanvas,drawPrivacyMasks} from '../web/canvas.js';
import {buildPresentation} from '../web/timeline.js';

const fakeCtx=()=>new Proxy({measureText:()=>({width:10})}, {
  get(obj,key){return key in obj?obj[key]:()=>{};},set(){return true;}
});
function fakeCanvas(){
  const ctx=fakeCtx(),captures=new Set();
  return {
    width:400,height:800,parentElement:{style:{}},style:{},
    listeners:new Map(),getContext:()=>ctx,addEventListener(event,fn){this.listeners.set(event,fn);},
    getBoundingClientRect(){return {left:0,top:0,width:400,height:800};},
    setPointerCapture(id){captures.add(id);},hasPointerCapture(id){return captures.has(id);},releasePointerCapture(id){captures.delete(id);}
  };
}
const ev=(id,x,y)=>({pointerId:id,pointerType:'touch',clientX:x,clientY:y,button:0,preventDefault(){}});
function editorFixture(){
  globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({imageSmoothingEnabled:true,drawImage(){}})})};
  const operations=[],step={id:'step',annotations:[]},canvas=fakeCanvas();
  let prompts=0,changes=0;
  const editor=new AnnotationCanvas(canvas,()=>changes++,async()=>{prompts++;return 'hi';},op=>operations.push(op));
  editor.step=step;editor.image={naturalWidth:400,naturalHeight:800};
  return {editor,step,canvas,operations,stats:()=>({prompts,changes})};
}
test('two fingers cancel an in-progress shape and zoom, without recording an edit event',()=>{
  const {editor,step,operations}=editorFixture();
  editor.setTool('circle');
  editor.down(ev(1,100,150));editor.move(ev(1,200,200));
  assert.equal(step.annotations.length,1);
  editor.down(ev(2,300,150)); // discard unfinished circle
  assert.equal(step.annotations.length,0);
  editor.move(ev(2,350,150));
  assert.ok(editor.viewport.scale>1);
  editor.up(ev(1,100,150));editor.up(ev(2,350,150));
  assert.equal(step.annotations.length,0);
  assert.equal(operations.length,0);
  assert.equal(editor.suppressUntilEmpty,false);
});
test('two-finger text action never opens the prompt, one-finger tap does',async()=>{
  const {editor,step,stats}=editorFixture();
  editor.setTool('text');
  editor.down(ev(1,100,150));editor.down(ev(2,180,200));
  editor.up(ev(2,180,200));editor.up(ev(1,100,150));
  assert.equal(stats().prompts,0);
  editor.down(ev(3,120,180));editor.up(ev(3,120,180));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stats().prompts,1);assert.equal(step.annotations.length,1);
});
test('brush width, mosaic geometry, and highlighter have stable normalized state',()=>{
  const {editor,step,operations}=editorFixture();
  editor.setWidth(.031);editor.setTool('highlighter');
  editor.down(ev(1,120,200));editor.move(ev(1,230,240));editor.up(ev(1,230,240));
  assert.equal(step.annotations[0].type,'highlighter');assert.equal(step.annotations[0].width,.031);
  editor.setTool('mosaic');editor.down(ev(2,30,70));editor.move(ev(2,150,160));editor.up(ev(2,150,160));
  assert.equal(step.annotations[1].type,'mosaic');
  assert.equal(buildPresentation(step).cues.length,1,'mosaic must never play as a revealing cue');
  assert.deepEqual(operations.map(x=>x.action),['annotation.add','annotation.add']);
});
test('privacy masks and mosaic are handled before normal animation overlays',()=>{
  const log=[];
  globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({imageSmoothingEnabled:true,drawImage(){log.push('downsample')}})})};
  const ctx={save(){},restore(){},fillRect(){log.push('opaque')},drawImage(){log.push('pixelated')},set imageSmoothingEnabled(v){}};
  drawPrivacyMasks(ctx,{naturalWidth:800,naturalHeight:800},[
    {type:'mask',x:.1,y:.1,w:.2,h:.1},{type:'mosaic',x:.1,y:.3,w:.4,h:.2}
  ],800,800);
  assert.ok(log.includes('opaque'));assert.ok(log.includes('downsample'));assert.ok(log.includes('pixelated'));
});
