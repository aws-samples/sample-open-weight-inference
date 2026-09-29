# Security controls and deployment settings

EDDIE is a non-production sample. This page describes controls in the source and
template; it is not a claim that an arbitrary installation has passed a live
audit. Use synthetic data and assess your own security, privacy and regulatory
requirements before deployment.

## Identity and authorization

Cognito permits operator-created users, uses SRP sign-in and refresh tokens, and
issues no secret for the browser client. The API requires a Cognito access token.
The runtime re-verifies RS256 signatures, issuer, expiration, token type and
allowed client ID, even behind the AgentCore authorizer. JWKS retrieval is HTTPS
and host-pinned. Verification failures and unmapped actions are denied.

Projects and conversations are scoped to the authenticated subject. Client or
Advisor fields cannot select an authorization identity. Deployment, approval,
removal and optional knowledge-stack operations require separate capabilities;
see [the access model](architecture-overview.md#access-and-operations). The Advisor
cannot approve or execute a deployment. An approved plan binds the actor,
configuration, budget and expiry, which the execution boundary checks again.

**MFA is optional, not enforced.** TOTP is available, but a user can sign in with a
password alone. Cognito threat protection is configured in **AUDIT** mode. Temporary
passwords are valid for **180 days** unless used or reset; this accommodates lab
accounts and increases the time an unused credential must be protected. Review
these choices and test the complete sign-in flow before changing them.

## Network and data boundaries

- CloudFront serves a public static application shell. Its S3 origin blocks public
  access and permits reads through the configured distribution. WAF protects this
  delivery path; it does **not** protect direct AgentCore API requests.
- AgentCore uses AWS-managed public networking. Authenticated API access is not
  equivalent to private networking or an egress allowlist.
- The supported SageMaker trial uses network isolation and private serving
  subnets. IAM conditions constrain the model network and instance type. The
  SageMaker service API itself remains an authenticated AWS API.
- DynamoDB uses IAM access, a customer-managed KMS key, point-in-time recovery and
  deletion protection. Conversation expiry is checked in application code;
  asynchronous DynamoDB TTL deletion is not an authorization control.
- Advisor prompts and tool results are durable conversation data. Telemetry
  defaults to redacting their contents. Review logs, backups, exported projects
  and retained artifacts when defining retention and access requirements.
- Public model metadata and pricing are fetched from external services. Metadata
  is untrusted input and does not grant execution privileges. The optional COA
  connector forwards the caller's bearer token to its operator-configured HTTPS
  endpoint; configure only a trusted endpoint and compatible authorization.

The Advisor's `find_runbooks` and `read_runbooks` tools read bundled guidance
through a fixed catalogue. Reads are limited to three documents, reject arbitrary
paths and symlinks, and check content digests. They make no network request and
cannot supply solver evidence or deployment approval. The existing authenticated
`knowledge` action also exposes this library with the `READ` capability.

With CloudFront's default certificate, HTTPS redirects and security headers are
configured, but a TLS 1.2 minimum is **not enforced**. Supply a custom domain and
an ACM certificate in `us-east-1` to use the template's `TLSv1.2_2021` policy.

## Deployment settings to review

The [application template](../infra/cloudformation/application/eddie-app.yaml) is
the source of truth. Most settings below are CloudFormation parameters; the
identity settings are explicit template properties.

| Setting | Default or behavior | Review before use |
|---|---|---|
| `--expect-account` | Installer refuses an unexpected account | Replace `YOUR_ACCOUNT_ID` with your account; keep the guard |
| `Environment` | `dev` | Use a dedicated non-production environment |
| `ServingImageUri` | Empty; trial execution disabled | `--enable-inference` prepares a scanned, digest-pinned image; app approval is still required |
| `ProvisionUserGroups` | `true` on a new installation | Assign only the capabilities each user needs |
| `MfaConfiguration` | `OPTIONAL` | Decide whether MFA must be mandatory; test enrollment and challenges |
| `AdvancedSecurityMode` | `AUDIT` | Audit mode records threats rather than enforcing all protection actions |
| `TemporaryPasswordValidityDays` | `180` | Protect invitations and shorten this window where appropriate |
| `EnableWaf` | `true` | Covers CloudFront, not the direct API; installation currently starts in `us-east-1` |
| `FrontendDomainName`, `FrontendCertificateArn` | Empty | Configure both to enforce the higher TLS minimum |
| `AlarmEmail` | Empty | Enter a recipient and confirm the SNS subscription; empty means no email delivery |
| `LogRetentionDays` | `30` | Set retention and review access to logs and backups |
| `AdvisorModelId` | Configured Bedrock inference profile | Verify model access and its processing Regions against your data requirements |
| `CoaMcpEndpoint` and COA resource parameters | Empty | Optional integration; assess its identity, data and cost boundaries separately |

The [workshop bootstrap](../infra/cloudformation/workshop/eddie-sandbox.yaml) is a
separate lab installation path. Its installer and participant permissions are
intended for disposable sandbox accounts. Do not reuse those broad lab permissions
as an application role or production deployment policy.

The workshop's temporary-password secret uses a dedicated customer-managed KMS
key with automatic rotation. Access requires Secrets Manager and KMS permissions
in the lab account. Deleting the bootstrap deletes the secret and schedules its
key for deletion after the seven-day waiting period.

## Spending, supply chain and cleanup

The installer pins runtime dependencies and images, checks IAM policies and
requires a completed scan for the image being deployed. A completed scan is not
necessarily a clean scan: review its findings and current dependency advisories.
Scoped execution roles, durable jobs and an independent reconciler limit supported
trials. Estimates and expiry do not guarantee a maximum AWS bill. Confirm removal
and inspect retained resources; see [costs and cleanup](cost-budget.md).

Use normal AWS credentials for installation. Keep tokens, keys, generated
`config.json`, scan reports and live test evidence out of source control. Browser
configuration contains public installation identifiers, not secrets, but a sample
repository must not point at the developer's environment.

## Verification

From an activated development environment:

```bash
PYTHONPATH=backend .venv/bin/python -m pytest tests -m "not live"
python3 scripts/export_public_source.py --check
```

For an authorized installation, the installer runs additional IAM and live checks.
You can repeat the read-only configuration audit separately:

```bash
.venv/bin/python scripts/verify/security_audit.py --environment dev --region us-east-1
```

Review the resulting `.build/` reports for that installation and revision. Keep
those reports private: they can contain environment identifiers. Offline tests
cannot establish a live network boundary, model quality, capacity or cleanup.
Report suspected vulnerabilities through [SECURITY.md](../SECURITY.md).


## AWS documentation connection

The Advisor's read-only AWS Knowledge MCP connection is described in
[Advisor knowledge sources](advisor-knowledge.md#data-and-security-boundaries).
This adds one pinned public HTTPS destination. It sends predefined topic queries
and approved documentation URLs only, without project text or credentials.
`AwsDocumentationEnabled` controls the connection; it adds no IAM permissions.

Authentication, project tenancy, deployment approval and solver evidence gates are
unchanged. The added source receipt is stored under the existing user/project
conversation key. New tests cover hostile URLs and headers, redirects, response
bounds, malformed MCP output, timeouts, cancellation, source isolation and history
restoration. Retrieval does not certify model-written prose or account readiness.
