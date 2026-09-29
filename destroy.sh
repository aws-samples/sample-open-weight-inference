#!/usr/bin/env bash
#
# EDDIE teardown.
#
# Order matters: dynamic inference resources are owned by SDK controllers, not by
# CloudFormation, so they must be inventoried and removed while their controllers
# still exist. Deleting the stack first would orphan billable children.
#
# A failed cleanup stays visible. Requesting deletion is not proof that billing
# stopped, so residual resources are reported explicitly at the end.

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

ENVIRONMENT="${EDDIE_ENVIRONMENT:-dev}"
REGION="${EDDIE_REGION:-us-east-1}"
STACK="eddie-${ENVIRONMENT}"
ASSUME_YES=false
KEEP_ARTIFACTS=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)          ASSUME_YES=true; shift ;;
    --environment)     ENVIRONMENT="$2"; STACK="eddie-$2"; shift 2 ;;
    --region)          REGION="$2"; shift 2 ;;
    --delete-artifacts) KEEP_ARTIFACTS=false; shift ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./destroy.sh [options]

  --yes, -y            Do not prompt
  --environment NAME   Environment name (default: dev)
  --region REGION      AWS region (default: us-east-1)
  --delete-artifacts   Also delete the release/artifact bucket
                       (retained by default so a release can be re-installed)
USAGE
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_red=$'\033[31m'
c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_blue=$'\033[34m'
phase() { printf '\n%s==> %s%s\n' "$c_bold$c_blue" "$*" "$c_reset"; }
ok()    { printf '  %s[ok]%s %s\n' "$c_green" "$c_reset" "$*"; }
warn()  { printf '  %s[warn]%s %s\n' "$c_yellow" "$c_reset" "$*"; }
fail()  { printf '  %s[fail]%s %s\n' "$c_red" "$c_reset" "$*"; }
die()   { fail "$*"; exit 1; }

ACCOUNT_ID="$(aws sts get-caller-identity --region "$REGION" --query Account --output text)" \
  || die "no valid AWS credentials"

RESIDUAL=()

# ------------------------------------------------------------------ 1 inventory
phase "Phase 1/4  Inventory dynamic inference resources"

# These are controller-owned. This release does not create them, but a real
# installation can, so teardown must check rather than assume none exist.
IMPORTED="$(aws bedrock list-imported-models --region "$REGION" \
  --query 'modelSummaries[].modelName' --output text 2>/dev/null || echo "")"
if [[ -n "$IMPORTED" && "$IMPORTED" != "None" ]]; then
  warn "imported models present in this account: $IMPORTED"
  warn "EDDIE did not necessarily create these; they are NOT deleted automatically"
  RESIDUAL+=("bedrock imported models: $IMPORTED")
else
  ok "no Bedrock imported models found"
fi

ENDPOINTS="$(aws sagemaker list-endpoints --region "$REGION" \
  --name-contains "eddie" --query 'Endpoints[].EndpointName' --output text 2>/dev/null || echo "")"
if [[ -n "$ENDPOINTS" && "$ENDPOINTS" != "None" ]]; then
  warn "EDDIE-named SageMaker endpoints: $ENDPOINTS"
  RESIDUAL+=("sagemaker endpoints: $ENDPOINTS")
else
  ok "no EDDIE-named SageMaker endpoints found"
fi

if ! aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
     >/dev/null 2>&1; then
  warn "stack $STACK does not exist in $REGION; nothing to delete"
  exit 0
fi

BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" --output text)"

# ------------------------------------------------------------------ 2 confirm
phase "Phase 2/4  Confirm"

printf '  Account   %s\n  Region    %s\n  Stack     %s\n' "$ACCOUNT_ID" "$REGION" "$STACK"
printf '  This deletes the CloudFront distribution, API, Lambda, DynamoDB table\n'
printf '  (including its data), and the frontend bucket contents.\n'
if (( ${#RESIDUAL[@]} )); then
  printf '\n  %sUnowned inference resources were found and will NOT be deleted:%s\n' \
    "$c_yellow" "$c_reset"
  for r in "${RESIDUAL[@]}"; do printf '    - %s\n' "$r"; done
  printf '  Remove them deliberately, or hand them over to an owner.\n'
fi

if [[ "$ASSUME_YES" == false ]]; then
  printf '\n  Type the environment name (%s) to confirm: ' "$ENVIRONMENT"
  read -r reply
  [[ "$reply" == "$ENVIRONMENT" ]] || { warn "aborted"; exit 1; }
fi

# ------------------------------------------------------------------ 3 empty bucket
phase "Phase 3/4  Empty versioned frontend bucket"

# A versioned bucket cannot be deleted by CloudFormation while objects or delete
# markers remain, so every version is removed first.
if [[ -n "$BUCKET" && "$BUCKET" != "None" ]]; then
  python3 - "$BUCKET" "$REGION" <<'PY'
import sys
import boto3

bucket, region = sys.argv[1], sys.argv[2]
s3 = boto3.client("s3", region_name=region)
removed = 0
paginator = s3.get_paginator("list_object_versions")
try:
    for page in paginator.paginate(Bucket=bucket):
        batch = [
            {"Key": o["Key"], "VersionId": o["VersionId"]}
            for key in ("Versions", "DeleteMarkers")
            for o in page.get(key, [])
        ]
        for i in range(0, len(batch), 1000):
            s3.delete_objects(Bucket=bucket, Delete={"Objects": batch[i:i + 1000]})
            removed += len(batch[i:i + 1000])
    print(f"  removed {removed} object versions from {bucket}")
except s3.exceptions.NoSuchBucket:
    print(f"  bucket {bucket} already absent")
PY
  ok "bucket emptied"
else
  warn "no frontend bucket output found"
fi

# ------------------------------------------------------------------ 4 delete stack
phase "Phase 4/4  Delete stack"

# Deletion protection is deliberately on for the case table and the user pool so a
# stray delete cannot destroy case history or identities. Teardown clears it
# explicitly, which is the point: removal must be an intentional act.
TABLE="eddie-${ENVIRONMENT}-cases"
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  aws dynamodb update-table --table-name "$TABLE" --region "$REGION" \
    --no-deletion-protection-enabled >/dev/null 2>&1 \
    && ok "cleared deletion protection on $TABLE" \
    || warn "could not clear deletion protection on $TABLE"
fi

POOL_ID="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text 2>/dev/null)"
if [[ -n "$POOL_ID" && "$POOL_ID" != "None" ]]; then
  aws cognito-idp update-user-pool --user-pool-id "$POOL_ID" --region "$REGION" \
    --deletion-protection INACTIVE >/dev/null 2>&1 \
    && ok "cleared deletion protection on user pool $POOL_ID" \
    || warn "could not clear deletion protection on user pool $POOL_ID"
fi

# The KMS key is Retain-on-delete: it stays after teardown so encrypted backups
# remain readable. Report it rather than silently orphaning it.
KEY_ALIAS="alias/eddie-${ENVIRONMENT}"
if aws kms describe-key --key-id "$KEY_ALIAS" --region "$REGION" >/dev/null 2>&1; then
  RESIDUAL+=("KMS key $KEY_ALIAS (retained by policy; schedule deletion manually)")
fi

aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION"
printf '  waiting for deletion (a CloudFront distribution can take 15+ minutes)...\n'

if aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION" \
     2>/dev/null; then
  ok "stack $STACK deleted"
else
  STATUS="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "DELETED")"
  if [[ "$STATUS" == "DELETED" ]]; then
    ok "stack $STACK deleted"
  else
    fail "stack deletion did not complete: $STATUS"
    aws cloudformation describe-stack-events --stack-name "$STACK" --region "$REGION" \
      --query 'StackEvents[?ResourceStatus==`DELETE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
      --output table 2>/dev/null || true
    RESIDUAL+=("cloudformation stack $STACK in $STATUS")
  fi
fi

ARTIFACT_BUCKET="eddie-${ENVIRONMENT}-artifacts-${ACCOUNT_ID}"
if [[ "$KEEP_ARTIFACTS" == true ]]; then
  warn "retained artifact bucket $ARTIFACT_BUCKET (use --delete-artifacts to remove)"
  RESIDUAL+=("artifact bucket $ARTIFACT_BUCKET (retained deliberately)")
else
  aws s3 rb "s3://$ARTIFACT_BUCKET" --force --region "$REGION" 2>/dev/null \
    && ok "deleted artifact bucket" \
    || warn "could not delete $ARTIFACT_BUCKET"
fi

phase "Residual resources"
if (( ${#RESIDUAL[@]} )); then
  for r in "${RESIDUAL[@]}"; do printf '  - %s\n' "$r"; done
  printf '\n  These continue to incur cost until removed.\n'
  exit 1
fi
ok "no residual billable resources reported"
