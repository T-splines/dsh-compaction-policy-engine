# Contributing

Thanks for taking a look. This project is test-first and keeps the official engine as the
source of compaction semantics.

## Development

Requirements: Node.js 20+.

```bash
git clone https://github.com/T-splines/dsh-compaction-policy-engine.git
cd dsh-compaction-policy-engine
npm install   # installs the public DSH peer packages used by the tests
npm test
```

The unit suite uses `node --test` and local fakes; it does not need a running DSH. The smoke
script (`scripts/smoke.sh`) is for a real deployment.

## Pull requests

- Keep one logical change per commit. Use `feat:` / `fix:` / `test:` / `docs:` /
  `chore:` prefixes and explain *why*.
- Add a regression test for every bug fix. Settings-panel changes should extend the real
  bundle evaluation in `test/client.test.js`, not just static string checks.
- Do not modify `node_modules` or fork the official engine. If the parent package must
  change, document the assumption and add a contract test.
- Update `CHANGELOG.md` and keep the top version in sync with `package.json`.
