// Deterministic, zero-API-cost task router for the existing 3-subscription orchestrator.
// This module MUST NOT access networks, credentials or private files.
export const ROUTER_VERSION='1.0.0';
export const PROVIDERS=Object.freeze(['claude','codex','gemini']);
export const POLICY_MODES=Object.freeze(['auto','stable','manual']);
const GROUPS=Object.freeze({
  security: /\b(auth|security|permission|credential|token|oauth|secret|encrypt|login|payment|billing|access control|migration|schema|save format|serialization)\b|인증|보안|비밀|토큰|권한|결제|마이그레이션|저장\s*(?:형식|구조|버전)/i,
  ui: /\b(ui|ux|css|layout|screen|responsive|canvas|style|frontend|visual|component|animation)\b|화면|지도\s*(?:탭|표시)|인터페이스|디자인|스타일|반응형|버튼|메뉴|애니메이션/i,
  test: /\b(test|coverage|spec|regression|vitest|playwright|unit test|typecheck)\b|테스트|시험|회귀|검증\s*(?:코드|추가)/i,
  docs: /\b(doc|documentation|readme|translation|copywriting|research|report|guide)\b|문서|조사|보고서|가이드|설명문|번역/i,
  architecture: /\b(architecture|refactor|performance|optimization|orchestrat|concurrency|pipeline|engine)\b|아키텍처|설계|리팩터|최적화|성능|파이프라인|엔진|오케스트레이터/i
});
function checkTask(task){
  if(typeof task!=='string'||!task.trim()||task.length>2500)throw Error('Task must contain at most 2500 characters');
  return task;
}
function checkOptions(options){
  if(options==null)return {mode:'auto'};
  if(typeof options!=='object'||Array.isArray(options))throw Error('Invalid routing options');
  const mode=options.mode??'auto';
  if(!POLICY_MODES.includes(mode))throw Error('Unsupported routing mode');
  for(const key of ['controller','developer','reviewer']){
    if(options[key]!=null&&!PROVIDERS.includes(options[key]))throw Error('Unsupported provider for '+key);
  }
  if(mode==='manual'&&!options.controller)throw Error('Manual routing needs a controller');
  return {...options,mode};
}
export function classifyTask(task){
  checkTask(task);
  const matches=Object.fromEntries(Object.entries(GROUPS).map(([category,rule])=>[category,rule.test(task)]));
  const highRisk=matches.security;
  const category=highRisk?'security':matches.ui?'ui':matches.architecture?'architecture':matches.test?'test':matches.docs?'docs':'general';
  return {category,risk:highRisk?'high':matches.architecture?'medium':'low',matches};
}
export function routeTask(task,options={}){
  const cfg=checkOptions(options),classification=classifyTask(task);
  // Never derive routing from raw instructions embedded in task, only bounded categories.
  const {category,risk}=classification;
  const base={
    controller:'claude',
    developer:'codex',
    reviewer:'gemini',
    checks:['typecheck','unit-test','build'],
    mode:cfg.mode,
    category,risk,
    policyVersion:ROUTER_VERSION,
    // Provides no assertion about actual API model ID or inference effort.
    modelIds:{claude:null,codex:null,gemini:null},
    reasoningEfforts:{claude:null,codex:null,gemini:null},
    requiresHumanApproval:true,
    autoMerge:false,
    paidApiAllowed:false,
    explanationCode:'STABLE_DEFAULT'
  };
  if(cfg.mode==='auto'){
    if(category==='ui'||category==='docs'||category==='test'){
      base.controller='gemini';
      base.reviewer='claude';
      base.explanationCode=category.toUpperCase()+'_SPECIALIST';
    } else if(category==='security'){
      base.explanationCode='HIGH_RISK_STRICT_GATE';
    } else {
      base.explanationCode='CLAUDE_ARCHITECTURE';
    }
  }
  if(cfg.mode==='manual'){
    base.controller=cfg.controller;
    if(cfg.developer)base.developer=cfg.developer;
    if(cfg.reviewer)base.reviewer=cfg.reviewer;
    base.explanationCode='USER_MANUAL_OVERRIDE';
  }
  // In v1 only Codex implements code; other developer choices require future
  // execution backends and cannot silently enter production.
  if(base.developer!=='codex')throw Error('Only Codex development backend is currently implemented');
  if(base.reviewer===base.controller){
    if(cfg.mode==='manual'&&cfg.reviewer)throw Error('Controller and reviewer must be independent');
    base.reviewer=base.controller==='claude'?'gemini':'claude';
  }
  if(base.reviewer===base.developer){
    if(cfg.mode==='manual'&&cfg.reviewer)throw Error('Developer and reviewer must be independent');
    base.reviewer=base.controller==='claude'?'gemini':'claude';
  }
  if(base.reviewer===base.controller||base.reviewer===base.developer)throw Error('Cannot allocate independent reviewer');
  return Object.freeze({
    ...base,
    checks:Object.freeze([...base.checks]),
    modelIds:Object.freeze({...base.modelIds}),
    reasoningEfforts:Object.freeze({...base.reasoningEfforts})
  });
}
export function createRouteMetadata(route){
  // Safe for PUBLIC Actions logs. Intentionally excludes raw task text.
  if(!route||route.policyVersion!==ROUTER_VERSION)throw Error('Invalid route');
  return {
    policyVersion:route.policyVersion,mode:route.mode,category:route.category,
    risk:route.risk,controller:route.controller,developer:route.developer,
    reviewer:route.reviewer,explanationCode:route.explanationCode,
    autoMerge:false,paidApiAllowed:false,
    modelIds:route.modelIds,reasoningEfforts:route.reasoningEfforts
  };
}
