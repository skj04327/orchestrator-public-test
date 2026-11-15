# Private game read-only baseline preflight

This single-use draft workflow checks the **real private game on main**, not the public synthetic fixture. It runs npm ci, TypeScript typecheck, the original full Vitest unit suite, and production build using Node 22 in an ephemeral runner.

Security: the private repository uses only PRIVATE_GAME_READ_TOKEN with checkout persist-credentials:false; no CLI subscription credentials and no private write token are passed. All npm command output and errors are redirected to runner-local files, which are NEVER uploaded or printed. The only public Actions output is PASS/FAIL/exit code per stage. Temporary private files are deleted on completion. Do not print, upload, or retain original command logs.

This preflight is NOT a full LLM task integration, does not dispatch any prior failed task, does not create a private Draft PR, does not generate images, and does not deploy the Termux CLI. A failing unit test should be treated as a baseline signal; this workflow intentionally cannot disclose the underlying source or test name in public CI. It does not try to fix tests and does not skip the existing suite.

Workflow triggers on the exact new feature branch only. Review its CI run and keep the draft pending until the results are understood. GitHub public repository hosted Actions minutes may be subject to account limits; no external paid API or billing integration is added.
