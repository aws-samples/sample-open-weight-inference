#!/usr/bin/env bash
# Exercise installer setup without network access or cloud operations.
set -Eeuo pipefail
TEST_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_PYTHON="${PYTHON_BIN:-python3}"
TEST_PYTHON="$("$TEST_PYTHON" -c 'import sys; print(sys.executable)')"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/eddie-setup-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
TEST_PASSES=0

fail_test() {
  printf 'FAIL: %s\n' "$*" >&2
  if [[ -f "${CASE_ROOT:-}/calls.log" ]]; then cat "$CASE_ROOT/calls.log" >&2; fi
  if [[ -f "${CASE_ROOT:-}/output.log" ]]; then tail -15 "$CASE_ROOT/output.log" >&2; fi
  exit 1
}
pass_test() { TEST_PASSES=$((TEST_PASSES + 1)); printf 'PASS: %s\n' "$*"; }

# Real venv creation and interpreter checks; pip and external CLIs are recorded
# stand-ins so this suite cannot install packages or touch an AWS account.
new_case() {
  CASE_ROOT="$TEST_ROOT/$1 workspace"
  mkdir -p "$CASE_ROOT/frontend" "$CASE_ROOT/bin"
  cp "$TEST_REPO/deploy.sh" "$CASE_ROOT/deploy.sh"
  : > "$CASE_ROOT/requirements-dev.txt"
  : > "$CASE_ROOT/calls.log"
  ln -s "$TEST_PYTHON" "$CASE_ROOT/bin/python3"
  cat > "$CASE_ROOT/pip.py" <<'PIP'
import json, os, sys
from pathlib import Path
with Path("calls.log").open("a") as output:
    output.write(json.dumps({"command": "pip", "args": sys.argv[1:],
                             "prefix": sys.prefix, "executable": sys.executable}) + "\n")
if os.environ.get("TEST_FAIL_PIP") == sys.argv[1]:
    raise SystemExit(17)
PIP
  cat > "$CASE_ROOT/bin/npm" <<'NPM'
#!/bin/bash
printf 'npm %s\n' "$*" >> "$TEST_CALLS"
[[ "${TEST_FAIL_NPM:-false}" != true ]]
NPM
  cat > "$CASE_ROOT/bin/node" <<'NODE'
#!/bin/bash
printf 'node %s\n' "$*" >> "$TEST_CALLS"
exit 0
NODE
  cat > "$CASE_ROOT/bin/aws" <<'AWS'
#!/bin/bash
printf 'aws %s\n' "$*" >> "$TEST_CALLS"
if [[ "$1 $2" == 'sts get-caller-identity' ]]; then
  printf '%s\n' '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/example"}'
else
  exit 89
fi
AWS
  cat > "$CASE_ROOT/bin/docker" <<'DOCKER'
#!/bin/bash
printf 'docker %s\n' "$*" >> "$TEST_CALLS"
exit 0
DOCKER
  chmod +x "$CASE_ROOT/bin/npm" "$CASE_ROOT/bin/node" "$CASE_ROOT/bin/aws" "$CASE_ROOT/bin/docker"
  # Copies are isolated from one another. A separate case below creates its venv.
  if [[ -d "$TEST_ROOT/seed" ]]; then cp -R "$TEST_ROOT/seed" "$CASE_ROOT/.venv"; fi
}

invoke() {
  local result=0
  env -u PYTHON_BIN -u EDDIE_EXPECTED_ACCOUNT -u EDDIE_REGION -u EDDIE_ENVIRONMENT \
    -u EDDIE_ENABLE_INFERENCE -u EDDIE_ENABLE_WAF -u PYTHONPATH \
    PATH="$CASE_ROOT/bin:/usr/bin:/bin" TEST_CALLS="$CASE_ROOT/calls.log" \
    "$@" bash "$CASE_ROOT/deploy.sh" "${CASE_ARGS[@]}" \
    > "$CASE_ROOT/output.log" 2>&1 || result=$?
  CASE_RESULT="$result"
}
no_cloud_calls() {
  if grep -E '^(aws|docker) ' "$CASE_ROOT/calls.log" >/dev/null; then
    fail_test "local setup called a cloud or Docker command"
  fi
}
no_npm_calls() {
  if grep -F 'npm ' "$CASE_ROOT/calls.log" >/dev/null; then fail_test "unexpected npm call"; fi
}
assert_failure() { [[ "$CASE_RESULT" != 0 ]] || fail_test "failure did not stop setup"; }

new_case fresh
CASE_ARGS=(--setup-only)
invoke
if [[ "$CASE_RESULT" != 0 ]]; then cat "$CASE_ROOT/output.log"; fail_test "fresh setup failed"; fi
[[ -x "$CASE_ROOT/.venv/bin/python" ]] || fail_test "no local environment created"
grep -F -- '--require-virtualenv' "$CASE_ROOT/calls.log" >/dev/null || fail_test "pip could install globally"
grep -F -- "$CASE_ROOT/.venv" "$CASE_ROOT/calls.log" >/dev/null || fail_test "project environment not used"
grep -F -- 'npm ci --prefix ' "$CASE_ROOT/calls.log" >/dev/null || fail_test "npm lock not used"
no_cloud_calls
pass_test 'fresh checkout creates a local environment, uses the npm lock, and calls no AWS services'
cp -R "$CASE_ROOT/.venv" "$TEST_ROOT/seed"
printf 'keep\n' > "$CASE_ROOT/.venv/sentinel"
invoke
[[ "$CASE_RESULT" == 0 && -f "$CASE_ROOT/.venv/sentinel" ]] || fail_test "rerun replaced the environment"
no_cloud_calls
pass_test 'rerun reuses the existing environment'

new_case backend
rm "$CASE_ROOT/bin/node" "$CASE_ROOT/bin/npm"
CASE_ARGS=(--setup-only --skip-frontend)
invoke
[[ "$CASE_RESULT" == 0 ]] || fail_test "backend-only setup required frontend tools"
no_npm_calls
no_cloud_calls
pass_test 'backend-only setup works without Node or npm'

new_case pip_install_failure
CASE_ARGS=(--setup-only)
invoke TEST_FAIL_PIP=install
assert_failure
no_npm_calls
no_cloud_calls
pass_test 'failed Python installation stops setup'

new_case pip_check_failure
CASE_ARGS=(--setup-only)
invoke TEST_FAIL_PIP=check
assert_failure
no_npm_calls
no_cloud_calls
pass_test 'inconsistent Python dependencies stop setup'

new_case npm_failure
CASE_ARGS=(--setup-only)
invoke TEST_FAIL_NPM=true
assert_failure
no_cloud_calls
pass_test 'failed frontend installation stops setup'

new_case override
CASE_ARGS=(--setup-only --skip-frontend)
invoke "PYTHON_BIN=$TEST_ROOT/seed/bin/python"
[[ "$CASE_RESULT" == 0 ]] || fail_test "explicit virtual environment failed"
grep -F -- "$TEST_ROOT/seed" "$CASE_ROOT/calls.log" >/dev/null || fail_test "PYTHON_BIN was ignored"
no_cloud_calls
pass_test 'an explicit virtual environment is honored'

new_case global_python
CASE_ARGS=(--setup-only --skip-frontend)
BASE_PYTHON="$("$TEST_PYTHON" -c 'import sys; print(sys._base_executable)')"
invoke "PYTHON_BIN=$BASE_PYTHON"
assert_failure
[[ ! -s "$CASE_ROOT/calls.log" ]] || fail_test "global Python reached package installation"
pass_test 'an explicit global interpreter cannot receive package installs'

new_case incomplete
rm -rf -- "$CASE_ROOT/.venv"
mkdir "$CASE_ROOT/.venv"
printf 'keep\n' > "$CASE_ROOT/.venv/sentinel"
CASE_ARGS=(--setup-only --skip-frontend)
invoke
assert_failure
[[ -f "$CASE_ROOT/.venv/sentinel" && ! -s "$CASE_ROOT/calls.log" ]] || fail_test "incomplete environment was modified"
pass_test 'an incomplete environment fails without deleting existing files'

new_case symlink
rm -rf -- "$CASE_ROOT/.venv"
ln -s "$TEST_ROOT/seed" "$CASE_ROOT/.venv"
CASE_ARGS=(--setup-only --skip-frontend)
invoke
assert_failure
[[ -L "$CASE_ROOT/.venv" && ! -s "$CASE_ROOT/calls.log" ]] || fail_test "symbolic link received installs"
pass_test 'an implicit symlink cannot redirect local package installation'

new_case wrong_account
CASE_ARGS=(--expect-account 111111111111 --skip-frontend)
invoke
assert_failure
grep -F 'account mismatch' "$CASE_ROOT/output.log" >/dev/null || fail_test "account guard was not reached"
if grep '^aws ' "$CASE_ROOT/calls.log" | grep -v '^aws sts get-caller-identity ' >/dev/null; then
  fail_test "wrong-account run proceeded beyond the identity check"
fi
pass_test 'account mismatch still stops deployment before AWS writes'

new_case help
CASE_ARGS=(--help)
invoke
[[ "$CASE_RESULT" == 0 && ! -s "$CASE_ROOT/calls.log" ]] || fail_test "help caused setup side effects"
pass_test 'help performs no setup or cloud calls'
printf '%s installer setup checks passed\n' "$TEST_PASSES"
