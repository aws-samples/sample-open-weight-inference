# Getting started

Install the application into your own AWS account, create a sign-in, and compare
models before deciding whether to run an inference trial.

## Prerequisites

- AWS CLI v2 credentials authorized to create this repository's CloudFormation resources.
- Python 3.11 or newer with `venv` support. The deployed container and Lambda runtimes use Python 3.12.
- Node.js 24 LTS (24.15 or newer) with npm.
- A running Docker engine with Buildx for ARM64 container builds.

## Install

From the repository root, check your AWS account and run the installer:

```bash
aws sts get-caller-identity
./deploy.sh --region us-east-1 --expect-account YOUR_ACCOUNT_ID
```

Replace `YOUR_ACCOUNT_ID` with the 12-digit account returned by the identity check.
The account check prevents installation into a different account. Use your normal
AWS credential provider; no access key belongs in the source or frontend.

The script prepares Python dependencies in `.venv/` and frontend dependencies from
the committed npm lock file. These local directories are excluded from Git and
source exports. To reuse an existing virtual environment, set `PYTHON_BIN` to its
Python executable.

It builds the application, shows a CloudFormation change set, asks before
applying it, publishes the frontend and runs installation checks. It prints the
application URL and Cognito user pool. An install can create billable resources
before the CloudFormation confirmation: container repositories, image storage
and artifact publication are part of the build.

Start in `us-east-1`: the current installer creates CloudFront's WAF there.
Add `--enable-inference` to prepare the supported GPU trial path; starting a trial
still requires approval in the app. COA knowledge integration is optional and
installed separately.

The Advisor's default Bedrock model is configured through `EDDIE_ADVISOR_MODEL_ID`;
your account must have access to the selected model and its permitted inference
route. Model hosting constraints are entered separately for each project.

An installation check proves neither model quality nor a latency objective.
If the installer exits with an error, inspect its `.build/` reports and address
the reported failure before using the installation.

## Create your sign-in

1. Open **Amazon Cognito → User pools** in the installation Region.
2. Open the pool printed by the installer.
3. Create a user with your email address and a generated temporary password.
4. Open the printed application URL, sign in, and complete the password-change prompt.

New users can work with their own projects and use the Advisor. Deployment,
approval and operating permissions are separate Cognito groups; see the
[access model](architecture-overview.md#access-and-operations). There is no public
sign-up or shared demo password.

## Compare your first model

1. Select **New project**. In **Your needs**, describe an actual task, for example:
   “Categorize support tickets as billing, technical or account. A person reviews
   the result.” Enter your Region and budget. Leave unknown traffic or response
   targets blank.
2. In **Models & sources**, choose a model from the live Bedrock catalog, or
   inspect `Qwen/Qwen2.5-1.5B-Instruct` from Hugging Face. Inspecting the public
   metadata does not deploy the model.
3. Open **Compare hosting**. API pricing needs request and token estimates.
   Dedicated hosting needs a comparison period and serving schedule.
4. Open **View decision map** to inspect why each path was evaluated, ruled out
   or left unverified. Use **Save project** to retain your work.
5. Use **Tests** for representative inputs and expected answers. Scoring answers
   you supply is different from running a model benchmark.

The Advisor is optional. Use it to clarify a requirement or question a result;
you can enter and change the same requirements manually.

## Local frontend development

After installing the application, copy `frontend/public/config.example.json` to
`frontend/public/config.json` and fill it with that installation's CloudFormation
outputs: `AgentRuntimeArn`, `Region`, `UserPoolId` and `UserPoolClientId`.
Run `npm --prefix frontend run dev`. This configuration file is local and ignored
by Git; it contains public deployment identifiers, never a client secret or token.
Blank or missing configuration fails explicitly instead of connecting a fresh
checkout to somebody else's account.

Use `deploy.sh` to publish an installation: it regenerates `dist/config.json` from
the target stack. A plain frontend build copies any local configuration and is
not a deployment workflow.

## Enable a SageMaker trial

Re-run the installer with:

```bash
./deploy.sh --region us-east-1 --expect-account YOUR_ACCOUNT_ID --enable-inference
```

This prepares the reviewed serving image and trial prerequisites; it does not
create a GPU endpoint. Image and artifact storage can still incur charges.

Before approving a trial, configure a notification recipient, confirm the SNS
subscription and grant the intended user the necessary approval capability.
The review must show the supported model, Region, price estimate, budget and
expiry. Available quota does not guarantee capacity at creation time.

The current recipe is a small Qwen model on one `ml.g5.2xlarge` instance in
`us-east-1`, for 30–60 minutes. It is a test environment, not a production serving
configuration. The review is authoritative about the exact supported revision
and limits in your installation.

Follow **Deploy & monitor** for setup, authenticated test requests and removal.
Treat **Removal confirmed** as the end of the trial's running resources; a closed
browser or expired record does not stop AWS billing.

## Cost and removal

Platform resources, Advisor usage, image storage and any inference trials have
separate costs. The optional COA stack has its own standing costs and is not
installed by the default application workflow.

Remove trials in the application first. Confirm their resource ledgers are clear.
Run `./destroy.sh --help` and review retained resources before removing the
application itself; deleting a stack is not proof that every artifact or separately
installed service has been removed.

## Maintaining deployment dependencies

The Lambda packager imports PyPA's `installer` API. It downloads only the Linux
ARM64 wheels in `backend/deployment-wheels.json`, verifies their SHA-256 and
internal file hashes, then installs them without executing package code or
starting another process.

When changing `backend/deployment-requirements.txt`, maintainers must refresh and
review the wheel lock. The commands below target the Python 3.12 Lambda runtime:

```bash
mkdir -p .build
python -m pip --isolated install --dry-run --ignore-installed --only-binary=:all: \
  --platform manylinux2014_aarch64 --platform manylinux_2_28_aarch64 \
  --implementation cp --python-version 3.12 --abi cp312 --abi abi3 --abi none \
  --index-url https://pypi.org/simple --report .build/deployment-resolution.json \
  -r backend/deployment-requirements.txt
python scripts/build_deployment_package.py --lock-from-report .build/deployment-resolution.json
python scripts/build_deployment_package.py --output .build/deployment-services.zip
```

Commit the requirements and reviewed lock together. A normal package build fails
if they disagree; it does not resolve new dependency versions automatically.
