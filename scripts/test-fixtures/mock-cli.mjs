#!/usr/bin/env node
// Stand-in for subscription CLIs and npm, only in the isolated public fixture test.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
const name=basename(process.argv[1]);
const args=process.argv.slice(2);
const prompt=args.join(' ');
const pack=(prompt.match(/Current isolated workpack (P[1-4])/)||[])[1]||null;
appendFileSync(process.env.MOCK_CALL_LOG,JSON.stringify({tool:name,kind:pack||'generic'})+'\n');
if(name==='npm'){
  if(args[0]==='test'&&process.env.MOCK_FAIL_TESTS==='1'){
    console.error('Synthetic fixture test failed (no real source).');
    process.exit(1);
  }
  process.exit(0);
}
if(name==='claude'){
  const result=prompt.includes('strict independent code reviewer')?'PASS\nFixture review':readFileSync(process.env.MOCK_PLAN_FILE,'utf8');
  console.log(JSON.stringify({is_error:false,result}));
  process.exit(0);
}
if(name==='agy'){
  if(prompt.includes('Return ONLY strict JSON'))console.log(readFileSync(process.env.MOCK_PLAN_FILE,'utf8'));
  else console.log('PASS\nFixture review');
  process.exit(0);
}
if(name==='codex'&&args.includes('--image')){
  console.log('A reference village with rows of houses and a river.');
  process.exit(0);
}
if(name==='codex'){
  const dir=process.env.MOCK_GAME_ROOT;
  const file=pack==='P2'?'generated-two.ts':'generated-one.ts';
  mkdirSync(join(dir,'src'),{recursive:true});
  writeFileSync(join(dir,'src',file),'export const '+(pack==='P2'?'two':'one')+' = true;\n');
  if(process.env.MOCK_ADD_TEST==='1'){
    mkdirSync(join(dir,'tests'),{recursive:true});
    writeFileSync(join(dir,'tests','generated.test.ts'),'// synthetic NEW test fixture\n');
  }
  process.exit(0);
}
process.exit(99);
