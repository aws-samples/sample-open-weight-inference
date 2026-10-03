#!/usr/bin/env bash
#
# EDDIE installer.
#
# Phases (docs/getting-started.md):
#   1 preflight  2 build  3 deploy  4 publish frontend  5 verify  6 outputs
#
# Re-running converges on existing resources. Every phase reports concrete
# evidence, and a failed required phase exits non-zero.

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

ENVIRONMENT="${EDDIE_ENVIRONMENT:-dev}"
REGION="${EDDIE_REGION:-us-east-1}"
STACK="eddie-${ENVIRONMENT}"
ENABLE_WAF="${EDDIE_ENABLE_WAF:-true}"
ENABLE_INFERENCE="${EDDIE_ENABLE_INFERENCE:-false}"
PLAN_ONLY=false
SETUP_ONLY=false
SKIP_FRONTEND=false
ASSUME_YES=false
EXPECTED_ACCOUNT="${EDDIE_EXPECTED_ACCOUNT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan-only)    PLAN_ONLY=true; shift ;;
    --setup-only)   SETUP_ONLY=true; shift ;;
    --skip-frontend) SKIP_FRONTEND=true; shift ;;
    --yes|-y)       ASSUME_YES=true; shift ;;
    --environment)  ENVIRONMENT="$2"; STACK="eddie-$2"; shift 2 ;;
    --region)       REGION="$2"; shift 2 ;;
    --enable-waf)   ENABLE_WAF=true; shift ;;
    --enable-inference) ENABLE_INFERENCE=true; shift ;;
    --alarm-email)  EDDIE_ALARM_EMAIL="$2"; shift 2 ;;
    --expect-account) EXPECTED_ACCOUNT="$2"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./deploy.sh [options]

  --setup-only        Prepare local dependencies without calling AWS
  --plan-only         Validate and show the change set without provisioning
  --skip-frontend     Deploy infrastructure only
  --yes, -y           Do not prompt before applying
  --environment NAME  Environment name (default: dev)
  --region REGION     AWS region (default: us-east-1)
  --enable-waf        Attach a CloudFront WAF WebACL (adds standing cost)
  --expect-account ID Fail unless the caller is in this account
  --enable-inference Copy and scan the AWS serving image to enable bounded GPU trials

Environment: EDDIE_ENVIRONMENT, EDDIE_REGION, EDDIE_ENABLE_WAF,
             EDDIE_EXPECTED_ACCOUNT, EDDIE_ENABLE_INFERENCE, EDDIE_SERVING_IMAGE
             PYTHON_BIN (optional existing virtual-environment interpreter)
USAGE
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

BUILD_DIR="$REPO/.build"
ARTIFACT_BUCKET="eddie-${ENVIRONMENT}-artifacts-"

# ---------------------------------------------------------------- helpers
c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'
c_red=$'\033[31m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_blue=$'\033[34m'

phase()  { printf '\n%s==> %s%s\n' "$c_bold$c_blue" "$*" "$c_reset"; }
ok()     { printf '  %s[ok]%s %s\n' "$c_green" "$c_reset" "$*"; }
warn()   { printf '  %s[warn]%s %s\n' "$c_yellow" "$c_reset" "$*"; }
fail()   { printf '  %s[fail]%s %s\n' "$c_red" "$c_reset" "$*"; }
info()   { printf '  %s%s%s\n' "$c_dim" "$*" "$c_reset"; }

die() { fail "$*"; exit 1; }

trap 'fail "deploy.sh failed at line $LINENO"' ERR

need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"; }

stack_output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null
}

# ---------------------------------------------------------------- 1 preflight
if [[ "$SETUP_ONLY" == true ]]; then
  phase "Local dependency setup"
else
  phase "Phase 1/6  Preflight"
  need aws
  need docker
  docker info >/dev/null 2>&1 || die "Docker daemon is not running"
  docker buildx version >/dev/null 2>&1 || die "Docker Buildx is required"
fi
need python3
if [[ "$SKIP_FRONTEND" == false ]]; then
  need node
  need npm
fi

# Install only into a virtual environment. PYTHON_BIN continues to support an
# existing operator-selected environment; the default belongs to this checkout.
if [[ -z "${PYTHON_BIN:-}" ]]; then
  [[ ! -L "$REPO/.venv" ]] || die ".venv is a symbolic link; select the intended virtual environment with PYTHON_BIN"
  if [[ -e "$REPO/.venv" ]]; then
    [[ -x "$REPO/.venv/bin/python" ]] || die ".venv is incomplete; move it aside and rerun setup"
  else
    python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
      || die "Local setup requires Python 3.11 or newer"
    info "creating a local Python environment in .venv"
    python3 -m venv "$REPO/.venv" \
      || die "could not create .venv; install Python with venv support"
  fi
  PYTHON_BIN="$REPO/.venv/bin/python"
fi
need "$PYTHON_BIN"
if ! "$PYTHON_BIN" - <<'PYCHECK'
import sys
if sys.version_info < (3, 11):
    raise SystemExit("Local setup requires Python 3.11 or newer.")
if sys.prefix == sys.base_prefix:
    raise SystemExit("PYTHON_BIN must select a virtual environment. Omit it to let the installer create .venv.")
PYCHECK
then
  die "selected Python environment cannot be used"
fi
info "preparing Python dependencies"
"$PYTHON_BIN" -m pip install --require-virtualenv --disable-pip-version-check --quiet \
  -r "$REPO/requirements-dev.txt" || die "Python dependency installation failed"
"$PYTHON_BIN" -m pip check || die "Python dependencies are inconsistent"
if [[ "$SKIP_FRONTEND" == false ]]; then
  info "preparing frontend dependencies from package-lock.json"
  npm ci --prefix "$REPO/frontend" --no-audit --no-fund --silent \
    || die "frontend dependency installation failed"
fi
ok "local dependencies ready"
if [[ "$SETUP_ONLY" == true ]]; then
  info "Setup complete. No AWS resources were created."
  exit 0
fi

IDENTITY_JSON="$(aws sts get-caller-identity --region "$REGION" --output json)" \
  || die "no valid AWS credentials for region $REGION"
ACCOUNT_ID="$("$PYTHON_BIN" -c 'import json,sys;print(json.load(sys.stdin)["Account"])' <<<"$IDENTITY_JSON")"
CALLER_ARN="$("$PYTHON_BIN" -c 'import json,sys;print(json.load(sys.stdin)["Arn"])' <<<"$IDENTITY_JSON")"
ok "account $ACCOUNT_ID  region $REGION"
info "caller $CALLER_ARN"

if [[ -n "$EXPECTED_ACCOUNT" && "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT" ]]; then
  die "account mismatch: caller is $ACCOUNT_ID but --expect-account is $EXPECTED_ACCOUNT"
fi

if [[ "$ENABLE_WAF" == true && "$REGION" != "us-east-1" ]]; then
  die "CloudFront WAF requires CLOUDFRONT scope in us-east-1; deploying to $REGION"
fi

# Confirm the evidence APIs the application depends on actually answer.
if aws pricing get-products --service-code AmazonSageMaker --region us-east-1 \
      --filters 'Type=TERM_MATCH,Field=instanceName,Value=ml.g5.2xlarge' \
      --max-results 1 >/dev/null 2>&1; then
  ok "Price List API reachable"
else
  warn "Price List API call failed; deployed /rates will fall back to pinned evidence"
fi

if aws bedrock list-foundation-models --region "$REGION" >/dev/null 2>&1; then
  ok "Bedrock catalog reachable in $REGION"
else
  warn "bedrock:ListFoundationModels failed; /catalog/models will report unavailable"
fi

ARTIFACT_BUCKET="${ARTIFACT_BUCKET}${ACCOUNT_ID}"

PROVISION_USER_GROUPS="$("$PYTHON_BIN" "$REPO/scripts/resolve_user_groups.py" \
  --stack "$STACK" --region "$REGION")" \
  || die "could not verify Cognito group ownership; no deployment started"
[[ "$PROVISION_USER_GROUPS" == true || "$PROVISION_USER_GROUPS" == false ]] \
  || die "invalid Cognito group ownership result"
[[ "$PROVISION_USER_GROUPS" == true ]] \
  || info "preserving existing Cognito groups and memberships outside the stack"

# ---------------------------------------------------------------- 2 build
phase "Phase 2/6  Build"

rm -rf "$BUILD_DIR"; mkdir -p "$BUILD_DIR"

if PYTHON_BIN="$PYTHON_BIN" bash "$REPO/tests/installer-setup.sh" >"$BUILD_DIR/setup-tests.log" 2>&1; then
  ok "installer setup checks passed"
else
  tail -25 "$BUILD_DIR/setup-tests.log"
  die "installer setup checks failed; refusing to build or deploy"
fi

# Use the selected interpreter for every phase. An explicit PYTHON_BIN may point
# to the tested environment while an older .venv still exists in the repository.
# Local test suite is a gate: never deploy a solver that fails its fixtures.
if "$PYTHON_BIN" -c 'import pytest' >/dev/null 2>&1; then
  if "$PYTHON_BIN" -m pytest tests/unit tests/contracts -q >"$BUILD_DIR/pytest.log" 2>&1; then
    ok "unit tests passed ($(grep -Eo '[0-9]+ passed' "$BUILD_DIR/pytest.log" | tail -1))"
  else
    tail -25 "$BUILD_DIR/pytest.log"
    die "unit tests failed; refusing to deploy (see $BUILD_DIR/pytest.log)"
  fi
else
  die "selected Python environment lacks pytest; install requirements-dev.txt before deploying"
fi

# SEC-03 gate, before anything is built or created. A policy that grants too much has
# already granted it by the time the stack exists, so this runs at build time and
# refuses to continue. Negative fixtures for this auditor live in
# tests/contracts/test_iam_policy_audit.py.
if "$PYTHON_BIN" "$REPO/scripts/verify/iam_policy_audit.py" \
     --json "$BUILD_DIR/iam-report.json" >"$BUILD_DIR/iam-audit.log" 2>&1; then
  ok "IAM policy audit: $(tail -1 "$BUILD_DIR/iam-audit.log")"
else
  cat "$BUILD_DIR/iam-audit.log"
  die "IAM policy audit failed; refusing to build or deploy (SEC-03)"
fi

ECR_REPO="eddie-${ENVIRONMENT}-coordinator"
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
# Tag from the commit, plus a dirty marker when the tree has uncommitted changes.
# ECR tags are immutable, so tagging purely by HEAD meant uncommitted code rebuilt
# under an existing tag: the push was rejected (or silently no-op'd) and the stale
# image stayed live while deploy.sh reported success. A dirty tree gets its own tag.
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
if [[ -n "${EDDIE_IMAGE_TAG:-}" ]]; then
  # Installing from a source archive rather than a clone: there is no git metadata, so
  # every install would tag `nogit`. ECR tags are immutable here, so a second install in
  # the same account then fails at the digest check on the retry path -- which is the one
  # path that most needs to work. An explicit tag makes each install distinguishable.
  IMAGE_TAG="$EDDIE_IMAGE_TAG"
  info "using supplied image tag $IMAGE_TAG"
elif [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  IMAGE_TAG="${GIT_SHA}-dirty-$(date -u +%Y%m%dT%H%M%SZ)"
  warn "working tree is dirty; tagging image $IMAGE_TAG"
else
  IMAGE_TAG="$GIT_SHA"
fi
CONTAINER_URI="${ECR_REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"

if ! aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" \
     >/dev/null 2>&1; then
  info "creating ECR repository $ECR_REPO"
  aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" \
    --image-scanning-configuration scanOnPush=true \
    --image-tag-mutability IMMUTABLE \
    --encryption-configuration encryptionType=AES256 >/dev/null
fi
ok "ECR repository $ECR_REPO"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY" >/dev/null 2>&1 \
  || die "docker login to ECR failed"

# AgentCore Runtime requires linux/arm64.
info "building ARM64 coordinator image $IMAGE_TAG"
docker buildx build --platform linux/arm64 \
  -t "$CONTAINER_URI" -f "$REPO/backend/Dockerfile" "$REPO/backend" \
  --provenance=false --push \
  --metadata-file "$BUILD_DIR/docker-metadata.json" \
  >"$BUILD_DIR/docker-build.log" 2>&1 \
  || { tail -40 "$BUILD_DIR/docker-build.log"; die "container build/push failed"; }

# buildx has been observed to exit 0 while printing a push failure -- an immutable
# tag rejection left stale code running while this script reported success. Scan the
# log and compare the digest buildx recorded against what ECR now serves for the tag.
if grep -qiE "ERROR: failed to push|cannot be overwritten|immutable" \
     "$BUILD_DIR/docker-build.log"; then
  tail -20 "$BUILD_DIR/docker-build.log"
  die "container push was rejected; refusing to deploy stale code"
fi

BUILT_DIGEST="$(python3 -c '
import json, sys
try:
    meta = json.load(open(sys.argv[1]))
except Exception:
    print(""); raise SystemExit
print(meta.get("containerimage.digest", ""))
' "$BUILD_DIR/docker-metadata.json" 2>/dev/null)"

DIGEST="$(aws ecr describe-images --repository-name "$ECR_REPO" --region "$REGION" \
  --image-ids "imageTag=$IMAGE_TAG" --query 'imageDetails[0].imageDigest' --output text 2>/dev/null)"
[[ -n "$DIGEST" && "$DIGEST" != "None" ]] \
  || die "image $IMAGE_TAG is not in ECR after the push; refusing to deploy stale code"
if [[ -n "$BUILT_DIGEST" && "$BUILT_DIGEST" != "$DIGEST" ]]; then
  die "ECR tag $IMAGE_TAG serves $DIGEST but this build produced $BUILT_DIGEST; \
the push did not take effect and the deployment would run stale code"
fi
ok "pushed $CONTAINER_URI"
info "digest $DIGEST"

# Scan the actual runtime artifact before updating the service. Python dependency
# checks do not cover operating-system packages. A missing/failed scan is not clean.
# Critical findings stop this installer; remaining high findings stay visible and
# require review rather than being described as a security sign-off.
info "waiting for the runtime image vulnerability scan"
# ECR may briefly return ScanNotFoundException after accepting a push. Its
# scan-complete waiter treats that propagation delay as a terminal error.
# Wait for registration first; completion, digest and severity gates still apply.
"$PYTHON_BIN" scripts/verify/wait_for_image_scan.py \
  --repository "$ECR_REPO" --digest "$DIGEST" --region "$REGION" \
  || die "runtime image scan was not registered; refusing to update the service"
aws ecr wait image-scan-complete --repository-name "$ECR_REPO" \
  --image-id "imageDigest=$DIGEST" --region "$REGION" \
  || die "runtime image scan did not complete; refusing to update the service"
aws ecr describe-image-scan-findings --repository-name "$ECR_REPO" \
  --image-id "imageDigest=$DIGEST" --region "$REGION" \
  --output json >"$BUILD_DIR/runtime-image-scan.json" \
  || die "could not retrieve the runtime image scan"
if ! "$PYTHON_BIN" - "$BUILD_DIR/runtime-image-scan.json" "$DIGEST" <<'PYSCAN'
import json, sys
with open(sys.argv[1]) as source:
    scan = json.load(source)
if scan.get("imageScanStatus", {}).get("status") != "COMPLETE":
    raise SystemExit("Runtime image scan is not complete.")
if scan.get("imageId", {}).get("imageDigest") != sys.argv[2]:
    raise SystemExit("Runtime scan does not describe this image digest.")
counts = scan.get("imageScanFindings", {}).get("findingSeverityCounts", {})
critical, high = int(counts.get("CRITICAL", 0)), int(counts.get("HIGH", 0))
print(f"  Runtime image: {critical} critical, {high} high findings")
if critical:
    raise SystemExit("Critical runtime-image findings block deployment.")
if high:
    print("  WARNING: high findings remain open. Review runtime-image-scan.json; this is not a security sign-off.")
PYSCAN
then
  die "runtime image vulnerability gate failed"
fi

if [[ "$SKIP_FRONTEND" == false ]]; then
  if [[ -f "$REPO/frontend/package.json" ]]; then
    ( cd "$REPO/frontend"
      npm run build --silent
    ) || die "frontend build failed"
    [[ -d "$REPO/frontend/dist" ]] || die "frontend build produced no dist/ directory"
    ok "frontend built ($(find "$REPO/frontend/dist" -type f | wc -l | tr -d ' ') files)"
  else
    warn "frontend/package.json not present; deploying API only"
    SKIP_FRONTEND=true
  fi
fi

# ---------------------------------------------------------------- 3 deploy
phase "Phase 3/6  Deploy infrastructure"

if ! aws s3api head-bucket --bucket "$ARTIFACT_BUCKET" --region "$REGION" 2>/dev/null; then
  info "creating artifact bucket $ARTIFACT_BUCKET"
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$ARTIFACT_BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$ARTIFACT_BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-bucket-encryption --bucket "$ARTIFACT_BUCKET" \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null
  aws s3api put-public-access-block --bucket "$ARTIFACT_BUCKET" \
    --public-access-block-configuration \
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' >/dev/null
fi
ok "artifact bucket $ARTIFACT_BUCKET"

# Package the reconciliation worker. It is a Lambda rather than part of the
# coordinator container so that expiry enforcement survives the coordinator being
# broken or redeployed, and so its role can hold deletion authority the coordinator
# must not have.
RECONCILER_ZIP="$BUILD_DIR/reconciler.zip"
rm -f "$RECONCILER_ZIP"
(
  cd "$REPO/backend"
  # Only what the worker imports. The advisor, runtime and knowledge packages are
  # deliberately absent: a cleanup worker has no business holding them.
  zip -qr "$RECONCILER_ZIP" deploy solver catalog api netio \
    -x '*__pycache__*' -x '*.pyc'
) || die "could not package the reconciliation worker"
RECONCILER_SHA="$(shasum -a 256 "$RECONCILER_ZIP" | cut -c1-16)"
RECONCILER_KEY="reconciler/${RECONCILER_SHA}.zip"
aws s3 cp "$RECONCILER_ZIP" "s3://${ARTIFACT_BUCKET}/${RECONCILER_KEY}" \
  --region "$REGION" >/dev/null || die "could not upload the reconciliation worker"
ok "reconciliation worker packaged ($(du -h "$RECONCILER_ZIP" | cut -f1), key $RECONCILER_KEY)"

DEPLOYMENT_ZIP="$BUILD_DIR/deployment-services.zip"
"$PYTHON_BIN" "$REPO/scripts/build_deployment_package.py" --output "$DEPLOYMENT_ZIP" \
  >"$BUILD_DIR/deployment-package.log" 2>&1 \
  || { tail -20 "$BUILD_DIR/deployment-package.log"; die "deployment service packaging failed"; }
DEPLOYMENT_SHA="$(shasum -a 256 "$DEPLOYMENT_ZIP" | cut -c1-16)"
DEPLOYMENT_KEY="deployment-services/${DEPLOYMENT_SHA}.zip"
aws s3 cp "$DEPLOYMENT_ZIP" "s3://${ARTIFACT_BUCKET}/${DEPLOYMENT_KEY}" --region "$REGION" --only-show-errors
ok "deployment services packaged ($DEPLOYMENT_KEY)"
S3_PREFIX_LIST="$(aws ec2 describe-prefix-lists --region "$REGION" \
  --filters "Name=prefix-list-name,Values=com.amazonaws.${REGION}.s3" \
  --query 'PrefixLists[0].PrefixListId' --output text)"
[[ "$S3_PREFIX_LIST" == pl-* ]] || die "could not discover the Region's S3 prefix list"
# On a first install the application stack does not exist yet, so describe-stacks
# exits non-zero. Under `set -Eeuo pipefail` that aborted every fresh-account install
# here, before the stack was ever created. "No stack yet" means "no serving image yet".
SERVING_IMAGE="${EDDIE_SERVING_IMAGE:-$(stack_output ServingImage || true)}"
[[ "$SERVING_IMAGE" != "None" ]] || SERVING_IMAGE=""
if [[ "$ENABLE_INFERENCE" == true && -z "$SERVING_IMAGE" ]]; then
  [[ "$PLAN_ONLY" != true ]] || die "Prepare the serving image in a normal install; --plan-only cannot enable it."
  aws cloudformation deploy --template-file infra/cloudformation/inference-assets.yaml \
    --stack-name "eddie-${ENVIRONMENT}-serving-assets" --region "$REGION" \
    --parameter-overrides "Environment=$ENVIRONMENT" --no-fail-on-empty-changeset
  "$PYTHON_BIN" "$REPO/scripts/prepare_serving_image.py" --region "$REGION" \
    --environment "$ENVIRONMENT" --expect-account "$ACCOUNT_ID" \
    --output "$BUILD_DIR/serving-image.json" \
    >"$BUILD_DIR/serving-image.log" 2>&1 \
    || die "Serving image preparation or its scan failed; see $BUILD_DIR/serving-image.log"
  SERVING_IMAGE="$("$PYTHON_BIN" -c 'import json,sys; print(json.load(open(sys.argv[1]))["imageUri"])' "$BUILD_DIR/serving-image.json")"
fi

TEMPLATE="infra/cloudformation/application/eddie-app.yaml"
# The template exceeds CloudFormation's 51,200-byte inline limit, so it is validated
# and deployed from S3 rather than sent in the request body. Doing this unconditionally
# keeps one code path: a template that grows past the limit must not change how it is
# deployed.
TEMPLATE_KEY="templates/$(shasum -a 256 "$TEMPLATE" | cut -c1-16).yaml"
aws s3 cp "$TEMPLATE" "s3://${ARTIFACT_BUCKET}/${TEMPLATE_KEY}" \
  --region "$REGION" >/dev/null || die "could not upload the template"
TEMPLATE_URL="https://${ARTIFACT_BUCKET}.s3.${REGION}.amazonaws.com/${TEMPLATE_KEY}"
aws cloudformation validate-template --template-url "$TEMPLATE_URL" \
  --region "$REGION" >/dev/null || die "template validation failed"
ok "template validated ($(wc -c < "$TEMPLATE" | tr -d ' ') bytes, via S3)"


PARAMS=(
  "Environment=$ENVIRONMENT"
  "EnableWaf=$ENABLE_WAF"
  "ProvisionUserGroups=$PROVISION_USER_GROUPS"
  "ContainerUri=$CONTAINER_URI"
  "AdvisorModelId=${EDDIE_ADVISOR_MODEL_ID:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
  "AwsDocumentationEnabled=${EDDIE_AWS_DOCS_ENABLED:-true}"
  "CoaMcpEndpoint=${COA_MCP_ENDPOINT:-}"
  "CoaNeptuneClusterId=${COA_NEPTUNE_CLUSTER_ID:-}"
  "CoaEcsCluster=${COA_ECS_CLUSTER:-}"
  "CoaEcsServices=${COA_ECS_SERVICES:-}"
  "ArtifactBucket=$ARTIFACT_BUCKET"
  "ReconcilerCodeKey=$RECONCILER_KEY"
  "DeploymentCodeKey=$DEPLOYMENT_KEY"
  "S3PrefixListId=$S3_PREFIX_LIST"
  "ServingImageUri=$SERVING_IMAGE"
  "AlarmEmail=${EDDIE_ALARM_EMAIL:-}"
)
if [[ -n "${EDDIE_FRONTEND_DOMAIN:-}" || -n "${EDDIE_FRONTEND_CERTIFICATE_ARN:-}" ]]; then
  [[ -n "${EDDIE_FRONTEND_DOMAIN:-}" && -n "${EDDIE_FRONTEND_CERTIFICATE_ARN:-}" ]] \
    || die "Set both EDDIE_FRONTEND_DOMAIN and EDDIE_FRONTEND_CERTIFICATE_ARN."
  PARAMS+=("FrontendDomainName=$EDDIE_FRONTEND_DOMAIN" "FrontendCertificateArn=$EDDIE_FRONTEND_CERTIFICATE_ARN")
fi

if [[ "$PLAN_ONLY" == true ]]; then
  phase "Plan only - no provisioning"
  aws cloudformation deploy --template-file "$TEMPLATE" \
    --stack-name "$STACK" --region "$REGION" \
    --capabilities CAPABILITY_NAMED_IAM \
    --s3-bucket "$ARTIFACT_BUCKET" --s3-prefix templates \
    --parameter-overrides "${PARAMS[@]}" \
    --no-execute-changeset || true
  info "review the change set above, then re-run without --plan-only"
  exit 0
fi

if [[ "$ASSUME_YES" == false ]]; then
  printf '\n  This creates billable AWS resources in account %s (%s):\n' "$ACCOUNT_ID" "$REGION"
  printf '    CloudFront distribution, S3 bucket, AgentCore Runtime, Cognito user pool, ECR, DynamoDB (on-demand)'
  [[ "$ENABLE_WAF" == true ]] && printf ', WAF WebACL'
  printf '\n  Continue? [y/N] '
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]] || { warn "aborted by operator"; exit 1; }
fi

aws cloudformation deploy --template-file "$TEMPLATE" \
  --stack-name "$STACK" --region "$REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --s3-bucket "$ARTIFACT_BUCKET" --s3-prefix templates \
  --parameter-overrides "${PARAMS[@]}" \
  --no-fail-on-empty-changeset 2>&1 | tee "$BUILD_DIR/cfn-deploy.log" \
  || { die "stack deployment failed; see $BUILD_DIR/cfn-deploy.log"; }

STACK_STATUS="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query 'Stacks[0].StackStatus' --output text)"
case "$STACK_STATUS" in
  CREATE_COMPLETE|UPDATE_COMPLETE) ok "stack $STACK_STATUS" ;;
  *) die "stack in unexpected state: $STACK_STATUS" ;;
esac

RUNTIME_ARN="$(stack_output AgentRuntimeArn)"
USER_POOL_ID="$(stack_output UserPoolId)"
USER_POOL_CLIENT="$(stack_output UserPoolClientId)"
FRONTEND_URL="$(stack_output FrontendUrl)"
BUCKET="$(stack_output FrontendBucketName)"
DIST_ID="$(stack_output DistributionId)"
[[ -n "$RUNTIME_ARN" && "$RUNTIME_ARN" != "None" ]] || die "stack produced no AgentRuntimeArn output"
ok "runtime $RUNTIME_ARN"
ok "site $FRONTEND_URL"

# ---------------------------------------------------------------- 4 publish
phase "Phase 4/6  Publish frontend"

if [[ "$SKIP_FRONTEND" == true ]]; then
  warn "skipped (--skip-frontend)"
else
  RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
  # Runtime configuration is generated from stack outputs, never committed.
  "$PYTHON_BIN" - "$REPO/frontend/dist/config.json" "$RUNTIME_ARN" "$REGION" "$RELEASE_ID" \
           "$USER_POOL_ID" "$USER_POOL_CLIENT" <<'PYCFG'
import json, sys
path, runtime_arn, region, release, pool, client = sys.argv[1:7]
# Non-secret runtime configuration. The browser authenticates against Cognito and
# calls AgentCore Runtime directly; there is no API Gateway base URL.
with open(path, "w") as fh:
    json.dump({
        "agentRuntimeArn": runtime_arn,
        "region": region,
        "releaseId": release,
        "userPoolId": pool,
        "userPoolClientId": client,
    }, fh, indent=2)
PYCFG
  ok "config.json generated (release $RELEASE_ID)"

  # Keep prior hashed assets: an already-open browser can still request a lazy
  # chunk from the previous release. Publish entry point/config only after assets.
  aws s3 sync "$REPO/frontend/dist/" "s3://$BUCKET/" --region "$REGION" \
    --exclude "index.html" --exclude "config.json" \
    --cache-control "public,max-age=31536000,immutable" --only-show-errors
  aws s3 cp "$REPO/frontend/dist/index.html" "s3://$BUCKET/index.html" --region "$REGION" \
    --cache-control "no-cache,no-store,must-revalidate" --content-type "text/html" --only-show-errors
  aws s3 cp "$REPO/frontend/dist/config.json" "s3://$BUCKET/config.json" --region "$REGION" \
    --cache-control "no-cache,no-store,must-revalidate" --content-type "application/json" --only-show-errors
  ok "uploaded to s3://$BUCKET"

  INVALIDATION="$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
    --paths '/index.html' '/config.json' --region "$REGION" \
    --query 'Invalidation.Id' --output text)"
  ok "cache invalidation $INVALIDATION"
fi

# ---------------------------------------------------------------- 5 verify
phase "Phase 5/6  Verify"

REPORT="$BUILD_DIR/verify-report.json"
set +e
"$PYTHON_BIN" "$REPO/scripts/verify/verify_deployment.py" \
  --runtime-arn "$RUNTIME_ARN" \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$USER_POOL_CLIENT" \
  --region "$REGION" \
  --site-url "${FRONTEND_URL:-}" \
  --report "$REPORT"
VERIFY_RC=$?

# Security posture is asserted against live AWS configuration, not the template.
"$PYTHON_BIN" "$REPO/scripts/verify/security_audit.py" \
  --environment "$ENVIRONMENT" --region "$REGION" \
  --report "$BUILD_DIR/security-report.json"
SECURITY_RC=$?
set -e

# ---------------------------------------------------------------- 6 outputs
phase "Phase 6/6  Outputs"

printf '\n'
printf '  %sEDDIE%s  Evaluate, Design & Deploy Inference Environments\n' "$c_bold" "$c_reset"
printf '  %s\n' "------------------------------------------------------------"
printf '  Application   %s%s%s\n' "$c_bold$c_green" "$FRONTEND_URL" "$c_reset"
printf '  Runtime       %s\n' "$RUNTIME_ARN"
printf '  Cognito pool  %s  client %s\n' "$USER_POOL_ID" "$USER_POOL_CLIENT"
printf '  Account       %s   Region  %s\n' "$ACCOUNT_ID" "$REGION"
printf '  Stack         %s (%s)\n' "$STACK" "$STACK_STATUS"
printf '  WAF           %s\n' "$ENABLE_WAF"
printf '  Verify report %s\n' "$REPORT"
printf '  Logs          %s\n' "$BUILD_DIR"
printf '\n'

if [[ $SECURITY_RC -ne 0 ]]; then
  fail "security audit reported failures - the deployment is NOT qualified"
  info "inspect $BUILD_DIR/security-report.json"
  exit 1
fi

if [[ $VERIFY_RC -ne 0 ]]; then
  fail "verification reported failures - the deployment is NOT qualified"
  info "inspect $REPORT"
  exit 1
fi

ok "installation verified"
printf '\n  %sNote:%s these checks exercise the deployed application and live pricing.\n' "$c_yellow" "$c_reset"
printf '  They do not measure model latency. No inference endpoint was created,\n'
printf '  and no p99 has been qualified.\n\n'
