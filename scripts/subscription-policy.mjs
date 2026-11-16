// Deterministic, credential-free readiness check. These are evidence gates, not
// legal advice or a substitute for account/privacy/network approval.
const PUBLIC_REPOSITORY='skj04327/orchestrator-public-test';
const KNOWN=new Set(['claude','codex','agy','gemini']);
export const SUBSCRIPTION_SOURCES=Object.freeze({
  codex:'https://developers.openai.com/codex/noninteractive',
  claude:'https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md',
  gemini:'https://geminicli.com/docs/get-started/authentication/',
  agy:'https://antigravity.google/cli/install.sh'
});
export function assessSubscriptionCi(context){
  const reasons=new Set();
  if(!context||! /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(context.repository||'')||
    !['public','private'].includes(context.visibility)||!Array.isArray(context.providers)||
    context.providers.length<1||context.providers.length>4||new Set(context.providers).size!==context.providers.length)
    return {schemaVersion:1,allowed:false,reasons:['UNKNOWN_EXECUTION_CONTEXT'],providers:[]};
  if(context.providers.some(p=>!KNOWN.has(p)))
    return {schemaVersion:1,allowed:false,reasons:['UNKNOWN_PROVIDER'],providers:[]};
  const isPublic=context.visibility==='public'||context.repository===PUBLIC_REPOSITORY;
  if(context.repository===PUBLIC_REPOSITORY&&context.visibility!=='public')reasons.add('REPOSITORY_VISIBILITY_MISMATCH');
  for(const provider of context.providers){
    if(provider==='codex')reasons.add(isPublic?'CODEX_ACCOUNT_AUTH_PUBLIC_CI_DISALLOWED':'CODEX_CI_AUTH_LIFECYCLE_UNVERIFIED');
    if(provider==='claude')reasons.add('CLAUDE_RUNTIME_SCOPE_UNVERIFIED');
    if(provider==='agy')reasons.add('AGY_SUBSCRIPTION_CI_UNVERIFIED');
    if(provider==='gemini')reasons.add('GEMINI_SUBSCRIPTION_CI_SCOPE_UNVERIFIED');
  }
  // No provider is currently verified end-to-end for this runtime. An approval
  // boolean cannot turn missing evidence or a documented restriction into a pass.
  return {schemaVersion:1,allowed:false,reasons:[...reasons],
    providers:context.providers.map(provider=>({provider,sourceUrl:SUBSCRIPTION_SOURCES[provider]}))};
}
export function assertSubscriptionCi(context){
  const report=assessSubscriptionCi(context);
  if(!report.allowed){const error=Error('Subscription CI blocked');error.code='SUBSCRIPTION_CI_BLOCKED';error.report=report;throw error;}
  return report;
}
