# Offline npm runtime

Base Draft18/local579d4fc. Build a local package import and checker path without new services. Keep the existing npm install and stage commands. The host receives only an eligible checks-purpose snapshot and a Git-external private directory of already available tarballs. Derive the plan exclusively from its verified package-lock.json. Use exact public npm registry HTTPS package addresses and canonical SHA-512 integrity, bounded lock/entries/bytes, regular private files, and no remote lookups. Links and other dependency protocols are outside this profile. The verified package capability belongs to the exact same disk snapshot and stays host-only.

- Write failure tests for lock policy, tampering, purpose and capability binding. Implement plan, streamed archive and rehash on delivery to Docker.
- Seed the fresh npm cache with the local tarball command in the existing network-none sandbox. Cache import disables lifecycle scripts. Original npm ci executes lifecycle scripts in the same sandbox. Bind optional dependency provenance to the six-stage disk report and preserve earlier reports.
- Verify a synthetic registry-style locked npm tarball in real Docker including actual dependency install/use and lifecycle isolation. Run full tests, code review, document limitations and publish a stacked Draft PR.

Review found two source policy gaps. Reproduced and fixed root npm-shrinkwrap.json precedence and root/lock declarations that can select non-registry sources. Added overrides checks. Other review observations concern raw filesystem errors at the trusted host API boundary and existing private directory creation semantics. The job reports carry fixed failure classes.

Final unit suite 140/140, JavaScript, Bash, YAML and whitespace checks passed. Existing images and synthetic locked tarballs were used locally. The actual game requires separately approved execution input and collected tarballs before a real check.
