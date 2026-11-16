// No secret, auth file, game checkout, subprocess or provider request is read.
import {assessSubscriptionCi} from './subscription-policy.mjs';
const report=assessSubscriptionCi({repository:process.env.GITHUB_REPOSITORY,
  visibility:process.env.ORCHESTRATOR_REPOSITORY_VISIBILITY,providers:['claude','codex','agy']});
console.log(JSON.stringify(report));
if(!report.allowed)process.exitCode=1;
