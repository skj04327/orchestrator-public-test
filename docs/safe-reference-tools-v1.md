# Opt-in public references, private image reading and local MCP v1

This is a stacked **Draft PR**; it is not deployed to the installed Termux CLI. It builds on PR #7 and therefore #2–#6. No automatic merge or real private game execution is requested.

## Termux input examples (after manual integration/deployment)

- ai --reference 'https://ko.wikipedia.org/wiki/Goryeo' '이 자료를 참고해 마을 이동 코드를 개선해줘'
- ai --image /sdcard/Download/reference.png '첨부 화면을 참고해서 마을 길 배치를 개선해줘'
- ai --reference 'https://whc.unesco.org/en/list/1324/' --image /sdcard/Download/village.jpg '이 자료들을 참고해 지도 배치를 개선해줘'

The input task and optional metadata/media are stored ONLY on private game branch \`orchestrator/task-queue\` at \`docs/orchestrator/tasks/\`, \`docs/orchestrator/references/\` and \`docs/orchestrator/media/\`. The public Actions dispatch contains ONLY the opaque task ID; the public log contains only counts and PASS/FAIL.

Reference URLs are explicitly provided by the user; the LLM cannot discover and fetch arbitrary websites. The deterministic gateway allows only HTTPS hosts \`ko.wikipedia.org\`, \`en.wikipedia.org\`, \`commons.wikimedia.org\`, \`whc.unesco.org\`, \`www.unesco.org\`, \`github.com\`. It rejects IP/localhost/HTTP/credentials/nonstandard ports/redirects/binary responses and oversized pages. No authentication headers, private task text, source, cookies, or keys are sent as part of public fetch requests. HTML excerpts are bounded and treated as untrusted, potentially adversarial data, not system instructions.

One private reference image is supported: PNG or JPEG only, max 700,000 compressed bytes, up to 4096×4096 with a 12-million-pixel cap. The gateway checks file type/size, magic bytes and dimensions but **does not guarantee that the image fully decodes**, so malformed images may fail at the CLI. Codex CLI receives the image with \`codex exec --sandbox read-only --image PATH\` and returns a private bounded visual description for planning and code workpacks. The image itself is not committed to generated game PRs. Image creation/generation remains disabled and is blocked before publication.

## MCP: built-in and read-only
\`scripts/reference-mcp-server.mjs\` is a zero-dependency MCP stdio server. It exposes exactly three bounded, read-only tools: \`list_references\`, \`read_reference\`, and \`image_observation\`. The server does not fetch URLs, read arbitrary paths, execute commands, access secrets, install plugins or mutate the repository. Before invoking Claude Code planning/review, a random private temporary directory contains the fixed server config and a sanitized snapshot; Claude is passed \`--mcp-config PATH --strict-mcp-config\` and only three named \`mcp__goryeo_refs__...\` tools. Temporary files are removed at completion.

Current \`agy\` (Antigravity) CLI and Codex developer are not automatically connected to that MCP server, because their current CLI behavior with MCP is not yet live-verified. They receive bounded reference text via the normal task context. ChatGPT-connected plugins are NOT silently inherited into GitHub Actions. No arbitrary external MCP server or third-party plugin is installed.

## Testing
No secret/public external API/live subscriber calls are performed in CI. Tests use synthetic HTML and image headers, a mock Codex image analysis CLI, a mock GitHub API and a temporary synthetic game checkout. Includes rejected SSRF destinations, oversized content, invalid image files, model tool allowlisting, MCP JSON-RPC initialize/tools/list/call, regression for image-reading vs image-generating intents, and end-to-end workpacks.

Remaining steps: explicit production integration approval; live \`agy\` and Claude CLI MCP compatibility smoke tests, authentic image decoding, encrypted/private storage retention policy, more curated public reference sources, isolated GitHub Actions publishing job, actual game PR E2E. No paid API or image generator is added.
