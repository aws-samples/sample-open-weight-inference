# Contributing

Issues and pull requests are welcome. For a bug, include the version, reproduction
steps and expected behavior. Remove account identifiers, tokens, personal data and
private project content from reports. Use [SECURITY.md](SECURITY.md) for
vulnerabilities.

Before opening a pull request:

1. Keep the change focused and document any change to supported behavior.
2. Add regression coverage for changes to authorization, pricing or deployment.
3. Run the relevant checks:

```bash
./deploy.sh --setup-only
PYTHON_BIN=.venv/bin/python bash tests/installer-setup.sh
PYTHONPATH=backend .venv/bin/python -m pytest tests -m "not live"
npm --prefix frontend test
npm --prefix frontend run build
python3 scripts/export_public_source.py --check
```

Live tests and deployment can incur AWS charges; use an account and scope you are
authorized to operate. Do not commit generated configuration, build output or
private test evidence.

By contributing, you agree to license your contribution under [MIT-0](LICENSE).
All participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).
