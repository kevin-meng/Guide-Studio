/* Pure guide timeline model. Scene order and edit history remain separate from presentation order. */
export const TIMELINE_SCHEMA = 1;
const copy = v => JSON.parse(JSON.stringify(v));
export function normalizeStep(step, idFactory = () => crypto.randomUUID()) {
  if (!Array.isArray(step.annotations)) step.annotations = [];
  const used = new Set();
  let maxSeq = Math.max(Number(step.nextAnnotationSeq || 0), 0);
  for (const [index, o] of step.annotations.entries()) {
    if (!o.id || used.has(o.id)) o.id = idFactory();
    used.add(o.id);
    if (!Number.isSafeInteger(o.createdSeq) || o.createdSeq <= 0) o.createdSeq = index + 1;
    maxSeq = Math.max(maxSeq, o.createdSeq);
  }
  step.nextAnnotationSeq = maxSeq;
  step.nextEventSeq = Math.max(0, Number(step.nextEventSeq || 0));
  // The array order of a legacy screenshot is an approximation, not reconstructed history.
  if (!step.timelineSource) step.timelineSource = 'inferred-legacy';
  return step;
}
export function nextAnnotation(step, annotation, idFactory = () => crypto.randomUUID()) {
  normalizeStep(step, idFactory);
  step.nextAnnotationSeq += 1;
  return { ...annotation, id: idFactory(), createdSeq: step.nextAnnotationSeq, createdAt: new Date().toISOString() };
}
export function buildPresentation(step) {
  const active = (step.annotations || []).filter(a => a.type !== 'mask');
  const saved = step.presentation?.cues || [];
  const existing = new Map(saved.map((cue,i) => [cue.objectId, {...cue, savedOrder:i}]));
  const sorted = active.slice().sort((a,b) => {
    const A = existing.get(a.id), B = existing.get(b.id);
    if (A && B) return A.savedOrder - B.savedOrder;
    if (A) return -1;
    if (B) return 1;
    return (a.createdSeq || 0) - (b.createdSeq || 0);
  });
  const cues = sorted.map((a,i) => ({
    id: existing.get(a.id)?.id || `cue-${a.id}`,
    type:'annotation.enter', objectId:a.id, atMs:700+i*900,
    durationMs: Math.max(200, Math.min(1500, existing.get(a.id)?.durationMs || 540)),
    effect: existing.get(a.id)?.effect || (['arrow','circle','pen'].includes(a.type)?'draw':'fade')
  }));
  return {schemaVersion:TIMELINE_SCHEMA, timelineSource: step.presentation?.timelineSource || step.timelineSource || 'recorded',
    durationMs: Math.max(2400, 700+cues.length*900+850), subtitle:step.presentation?.subtitle ?? step.description ?? '',
    transition:{in:'fade',out:'cut'}, cues};
}
export function reorderCue(step, objectId, direction) {
  const p = buildPresentation(step);
  const i = p.cues.findIndex(c => c.objectId === objectId), j = i + direction;
  if (i < 0 || j < 0 || j >= p.cues.length) return false;
  [p.cues[i],p.cues[j]]=[p.cues[j],p.cues[i]];
  p.cues.forEach((cue,k) => cue.atMs=700+k*900);
  p.timelineSource='manual';
  step.presentation=p;
  return true;
}
export function timelineForGuide(guide) {
  let offset=0;
  const entries=(guide.steps||[]).filter(s=>s.imageData||s.imageUrl).map((step,index)=>{
    const presentation=buildPresentation(step);
    const entry={step,index,atMs:offset,durationMs:presentation.durationMs,presentation};
    offset+=presentation.durationMs;
    return entry;
  });
  return {entries,totalMs:offset};
}
export function makeEditEvent(step, guideId, sessionId, operation) {
  normalizeStep(step);
  step.nextEventSeq += 1;
  // A single pointer gesture is one semantic event, never hundreds of pointermove messages.
  return {eventId:crypto.randomUUID(),guideId,stepId:step.id,sessionId,seq:step.nextEventSeq,
    at:new Date().toISOString(),action:operation.action,objectId:operation.objectId ?? null,
    before:operation.before == null ? null : copy(operation.before),
    after:operation.after == null ? null : copy(operation.after),
    ...(operation.gestureDurationMs ? {gestureDurationMs:Math.round(operation.gestureDurationMs)} : {})};
}
