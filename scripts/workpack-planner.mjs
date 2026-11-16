// Private natural-language task decomposition into bounded, sequential workpacks.
// The model may propose tasks, but deterministic policy selects which worker may run them.
// Never print raw user instructions, plans, source, or credentials into public Actions.
const MAX_PACKS=4;
const MAX_CODE=3;
const PLAN_VERSION=1;
const PATH=/^(?:src\/(?!assets\/)[a-zA-Z0-9_./-]+\.(?:ts|tsx)|tests\/[a-zA-Z0-9_./-]+\.test\.ts)$/;
const IMG=/\b(?:images?|portraits?|sprites?|textures?|illustrations?|artwork|graphics|icons?|visual assets)\b|이미지|그림|초상화|일러스트|스프라이트|텍스처|삽화|아이콘|캐릭터\s*(?:이미지|그림)/i;
const clean=(s,min,max)=>typeof s==='string'&&s.trim().length>=min&&s.length<=max;
export const WORKPLAN_VERSION=PLAN_VERSION;
export const MAX_CODE_WORKPACKS=MAX_CODE;
export function requiresImageGeneration(task){
  if(!clean(task,1,2500))throw Error('Invalid task');
  // Merely saying "look at this image" is image READING, not generation.
  if(!IMG.test(task))return false;
  const referenceCue=/(?:이미지|그림|초상화|일러스트|스프라이트|텍스처|아이콘)(?:를|을|와|과)?\s*(?:보고|읽고|참고|분석|비교|활용)/i;
  const explicitAsset=/\b(?:generate|create|draw|render)\s+(?:images?|portraits?|sprites?)\b|(?:이미지|초상화|스프라이트|일러스트)(?:\s*\d+\s*장)?\s*(?:생성|제작|그려|만들|추가)/i;
  if(referenceCue.test(task)&&!explicitAsset.test(task))return false;

  const KR=/(?:이미지|그림|초상화|일러스트|스프라이트|텍스처|아이콘|캐릭터\s*그림).{0,36}(?:생성|제작|만들|그려|그리|추가|출력|넣어|그림으로)|(?:생성|제작|만들|그려|그리|출력).{0,36}(?:이미지|그림|초상화|일러스트|스프라이트|텍스처|아이콘)/i;
  const EN=/\b(?:generate|create|draw|render|produce|make)\s+(?:(?:an?|some|new|original|several|50)\s+)?(?:images?|portraits?|sprites?|textures?|illustrations?|icons?)\b|\b(?:images?|portraits?|sprites?|textures?|illustrations?|icons?)\b.{0,32}\b(?:generate|create|draw|render|produce|make|add)\b/i;
  return KR.test(task)||EN.test(task);
}
export function plannerContract(task){
  if(!clean(task,1,2500))throw Error('Invalid task');
  return [
    'Return ONLY strict JSON. No markdown, explanations or code fences.',
    'Schema: {"schemaVersion":1,"workpacks":[{"id":"P1","kind":"code","title":"short title","instructions":"specific isolated coding instructions","dependsOn":[],"files":["src/path/file.ts"]}]}',
    'Allowed kind: "code" or "image". For images use kind:"image", instructions describing artwork, files:[], and dependencies on earlier P IDs.',
    'Split work into 1-4 ordered workpacks, at most 3 code workpacks. Dependencies MUST reference earlier workpacks only.',
    'Make coding instructions small enough to fit changes to at most 8 existing/new source or test files TOTAL, with no existing test modifications.',
    'Never propose changes to assets, package/config files, CI or docs as coding outputs. Do not fabricate implementation results.',
    'If the request includes visual assets, portraits, icons, sprites, textures or illustrations, include at least one image workpack; NEVER silently replace images with text-only code.',
    'Images cannot currently be generated automatically. We will block the whole job safely rather than create an incomplete PR.',
    'Choose workpacks from the actual requested task and codebase, with concise instructions, and no commands to install, commit, deploy or pay.',
    'The controller plans ONLY; Codex is the ONLY supported source-code worker, and independent reviewer is separate.'
  ].join('\n');
}
function unwrap(raw){
  if(!clean(raw,2,16000))throw Error('Invalid structured plan length');
  const text=raw.trim();
  // Accept one surrounding JSON fence (common when a subscription CLI wraps JSON).
  if(text.startsWith('```')){
    const match=/^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
    if(!match)throw Error('Planner did not return a standalone JSON object');
    return match[1];
  }
  return text;
}
const onlyKeys=(obj,keys)=>Object.keys(obj).every(k=>keys.includes(k));
export function parseWorkplan(raw,task){
  const explicitImages=requiresImageGeneration(task);
  let input;
  try{input=JSON.parse(unwrap(raw));}catch{throw Error('Planner output is not valid JSON');}
  if(!input||Array.isArray(input)||typeof input!=='object'||
    !onlyKeys(input,['schemaVersion','workpacks'])||input.schemaVersion!==PLAN_VERSION||
    !Array.isArray(input.workpacks)||input.workpacks.length===0||input.workpacks.length>MAX_PACKS)
    throw Error('Planner schema or workpack count invalid');
  const packs=[];
  let countCode=0, countImages=0;
  for(const p of input.workpacks){
    if(!p||Array.isArray(p)||typeof p!=='object'||
      !onlyKeys(p,['id','kind','title','instructions','dependsOn','files'])||
      p.id!=='P'+(packs.length+1)||!['code','image'].includes(p.kind)||
      !clean(p.title,3,80)||!clean(p.instructions,10,1800)||
      !Array.isArray(p.dependsOn)||p.dependsOn.length>MAX_PACKS||
      !Array.isArray(p.files)||p.files.length>8)throw Error('Unsafe or unbounded workpack');
    if(p.kind==='code')countCode++;else countImages++;
    if(new Set(p.dependsOn).size!==p.dependsOn.length||
      p.dependsOn.some(d=>!packs.some(x=>x.id===d)))throw Error('Invalid workpack dependency');
    if(p.kind==='image'&&p.files.length)throw Error('Image output paths not yet supported');
    if(p.kind==='code'&&p.files.some(f=>typeof f!=='string'||!PATH.test(f)||f.includes('..')||f.includes('//')))
      throw Error('Unsafe workpack file hint');
    if(new Set(p.files).size!==p.files.length)throw Error('Duplicate workpack file hints');
    packs.push(Object.freeze({
      id:p.id,kind:p.kind,title:p.title.trim(),instructions:p.instructions.trim(),
      dependsOn:Object.freeze([...p.dependsOn]),files:Object.freeze([...p.files]),
      worker:p.kind==='code'?'codex':null
    }));
  }
  if(countCode>MAX_CODE)throw Error('Too many code workpacks');
  if(explicitImages&&!countImages)throw Error('Image workpack omitted by planner');
  return Object.freeze({
    schemaVersion:PLAN_VERSION,workpacks:Object.freeze(packs),
    codeCount:countCode,imageCount:countImages
  });
}
export function assertExecutableWorkplan(plan){
  if(!plan||plan.schemaVersion!==PLAN_VERSION||!Array.isArray(plan.workpacks))throw Error('Invalid workplan');
  if(plan.imageCount){
    const error=Error('Image generation backend is not configured; refusing incomplete game PR');
    error.failureKind='blocked_capability';
    throw error;
  }
  if(plan.codeCount===0)throw Error('No supported coding workpacks');
  return true;
}
export function makeCodePrompt({task,workpack,index,total,sourceRules}){
  if(!clean(task,1,2500)||workpack?.kind!=='code'||workpack.worker!=='codex'||
    !Number.isInteger(index)||index<1||index>MAX_CODE||
    !Number.isInteger(total)||total<index||
    !clean(sourceRules,1,2500))throw Error('Invalid implementation packet');
  return [
    'You are the Codex implementation worker for a private game. Workpack '+index+' of '+total+'.',
    sourceRules,
    'Original requested task: '+task,
    'Current isolated workpack '+workpack.id+': '+workpack.instructions,
    'Scope hints (not permission expansion): '+(workpack.files.join(', ')||'infer the fewest safe source files'),
    'Previous workpacks already modified the checkout. Preserve and build on their changes; do not revert them.',
    'Write actual code and appropriate NEW tests. Do not commit, push, deploy, install dependencies or create images.',
    'Never print private source, credentials or task instructions to terminal logs. Finish after saving changes to files.'
  ].join('\n');
}
