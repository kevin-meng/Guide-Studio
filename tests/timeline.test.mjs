import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeStep,nextAnnotation,buildPresentation,reorderCue,timelineForGuide,makeEditEvent} from '../web/timeline.js';
import {renderVideoFrame} from '../web/video.js';

const ids=()=>{let n=0;return()=>`generated-${++n}`;};
test('legacy annotations get stable IDs and inferred source without fabricating history',()=>{
 const step={id:'old',annotations:[{type:'circle',x:.1,y:.2},{type:'arrow',x:.2,y:.3},{type:'mask',x:0,y:0,w:.4,h:.4}]};
 normalizeStep(step,ids());const original=step.annotations.map(a=>a.id);
 normalizeStep(step,ids());assert.deepEqual(step.annotations.map(a=>a.id),original);
 assert.equal(step.timelineSource,'inferred-legacy');assert.equal(buildPresentation(step).cues.length,2);
 assert.equal(buildPresentation(step).cues[0].objectId,original[0]);
});
test('new objects increment seq and manual cue order persists',()=>{
 const step={id:'new',annotations:[],timelineSource:'recorded'};
 const gen=ids();const a=nextAnnotation(step,{type:'circle'},gen),b=nextAnnotation(step,{type:'arrow'},gen);
 step.annotations.push(a,b);assert.ok(a.createdSeq<b.createdSeq);
 assert.equal(reorderCue(step,b.id,-1),true);
 assert.deepEqual(buildPresentation(step).cues.map(c=>c.objectId),[b.id,a.id]);
 step.annotations.shift();assert.deepEqual(buildPresentation(step).cues.map(c=>c.objectId),[b.id]);
});
test('events are ordered, immutable snapshots and include undo',()=>{
 const step={id:'s',annotations:[]};
 const input={action:'annotation.add',objectId:'a',after:{x:.3}};
 const e1=makeEditEvent(step,'g','session',input);input.after.x=.8;
 const e2=makeEditEvent(step,'g','session',{action:'undo',objectId:'a',before:{x:.3},after:null});
 assert.equal(e1.seq,1);assert.equal(e2.seq,2);assert.equal(e1.after.x,.3);assert.equal(e2.action,'undo');
});
test('every rendered frame paints privacy mask before visible annotations',()=>{
 const calls=[];
 const ctx=new Proxy({}, {get(_,key){if(key==='measureText')return str=>({width:String(str).length*8});if(key==='canvas')return null;return (...args)=>{if(['drawImage','fillRect','stroke','fillText'].includes(key))calls.push({name:key,args});};},set(){return true;}});
 const canvas={width:540,height:960,getContext:()=>ctx};
 const step={id:'s',description:'privacy safe',imageData:'data:image/png;base64,abc',annotations:[
  {id:'mask',type:'mask',x:.1,y:.1,w:.2,h:.2},{id:'shape',type:'rect',x:.3,y:.3,w:.2,h:.2}]};
 const entry={step,atMs:0,durationMs:3000,presentation:{cues:[{objectId:'shape',atMs:0,durationMs:200}],subtitle:'safe'}};
 renderVideoFrame(canvas,{guide:{title:'guide'},entries:[entry],images:[{naturalWidth:100,naturalHeight:200}],totalMs:3000},1600);
 const bitmap=calls.findIndex(e=>e.name==='drawImage');
 const masked=calls.findIndex((e,i)=>i>bitmap&&e.name==='fillRect');
 assert.ok(bitmap>=0&&masked>bitmap,'mask must be drawn on the screenshot before any frame is captured');
});
test('multi-step durations sum and ordering follows steps, not object creation timestamps',()=>{
 const g={steps:[{id:'1',imageData:'a',annotations:[]},{id:'2',imageData:'b',annotations:[{id:'a',type:'circle',createdSeq:1}]}]};
 const t=timelineForGuide(g);assert.equal(t.entries.length,2);assert.equal(t.entries[1].atMs,t.entries[0].durationMs);assert.equal(t.totalMs,t.entries[0].durationMs+t.entries[1].durationMs);
});
