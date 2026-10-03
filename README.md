# <img src="frontend/public/brand/eddie-wordmark-color-v1.svg" alt="EDDIE" width="174">

**Evaluate, Design & Deploy Inference Environments**

## The problem

You have a model - or an application idea. Where should it run on AWS? What will it
cost for your traffic? Can it meet your response-time needs?

Answering those questions usually means piecing together model documentation,
pricing, service limits and deployment scripts. This accelerator brings that work
into one workspace.

## What it does

- **Discover:** browse Amazon Bedrock models or inspect a Hugging Face model.
- **Compare:** check supported Bedrock API, Custom Model Import and SageMaker
  options using AWS pricing and a deterministic solver.
- **Understand:** open the decision map to see costs, exclusions and missing
  evidence. An optional Advisor helps when you get stuck.
- **Size:** explore CPU or GPU experiments with model memory, traffic units,
  explicit assumptions and a recorded CPU speech example.
- **Tokenomics:** compare public On-Demand and 1-year/3-year Savings Plan costs
  for GPU pools, including upfront payments and the full commitment.
- **Evaluate:** score supplied example answers and keep performance evidence
  separate from estimates.
- **Try and remove:** approve a supported, budget- and time-limited SageMaker
  trial, send authenticated requests, and track resource removal.

Saved projects let you move freely between these steps. Missing measurements stay
**unverified**.

A **deployment recipe** is the code and configuration that packages a model,
starts its serving software, and runs an inference trial with a budget and time
limit. Included recipes support small Qwen2.5 text models, compatible fine-tuned
Qwen2 checkpoints, and Magpie speech on CPU. Inspecting a model does not
automatically make it deployable. See [Deployment recipes](docs/adding-a-deployment-recipe.md)
to enable an included recipe or add support for another model.

The Advisor uses [skill files](backend/knowledge/skills/) for decision methods and
[AWS Knowledge MCP](docs/advisor-knowledge.md) for current AWS documentation. Prices
and account facts come from AWS APIs; unavailable checks stay unverified.

## Quick start

Prepare AWS CLI v2 credentials, Python 3, Node.js/npm, and a running Docker engine
with Buildx. See the [deployment prerequisites](docs/getting-started.md#prerequisites).
Replace `YOUR_ACCOUNT_ID` with your target AWS account:

```bash
git clone https://github.com/aws-samples/sample-open-weight-inference.git
cd sample-open-weight-inference
./deploy.sh --region us-east-1 --expect-account YOUR_ACCOUNT_ID
```

The script prepares local dependencies, runs checks, deploys with CloudFormation,
and prints your application URL. [Create your sign-in](docs/getting-started.md#create-your-sign-in)
to start your first project.

**AWS charges apply.** Remove inference trials in the app before using
[destroy.sh](destroy.sh) to remove the application. See [costs and cleanup](docs/cost-budget.md).

## Security considerations

This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory and compliance requirements before deployment

Cognito MFA is optional, not enforced. Grant deployment and approval permissions
deliberately, use synthetic data, and review the [security controls and deployment
settings](docs/security-posture.md) before installing. Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md).

## Architecture

[![Architecture: Cloudscape workspace, authenticated AgentCore API, deterministic solver, and approved SageMaker trials](docs/images/architecture.png)](docs/images/architecture.svg)

The Advisor explains; the solver decides. CloudFront serves the frontend, while
authenticated API requests go directly to AgentCore.

## Documentation

| Task | Guide |
| --- | --- |
| Deploy, sign in, or remove the application | [Getting started](docs/getting-started.md) |
| Understand hosting paths and deployment decisions | [Architecture](docs/architecture-overview.md), [decision map](docs/decision-map.md) |
| Bring your own fine-tuned model | [Fine-tuned checkpoints](docs/fine-tuned-checkpoints.md) |
| Enable trials or support another model | [Deployment recipes](docs/adding-a-deployment-recipe.md) |
| Size compute and compare hosting costs | [CPU and GPU planning](docs/compute-planning.md), [cost model](docs/cost-model.md), [Tokenomics](docs/tokenomics.md) |
| Understand Advisor sources and decision methods | [AWS documentation MCP](docs/advisor-knowledge.md), [inference skills](docs/inference-runbooks.md) |
| Review access controls and security settings | [Security considerations](docs/security-posture.md) |
| Develop locally, test, or contribute | [Contributing](CONTRIBUTING.md) |

Licensed under [MIT-0](LICENSE). Third-party terms are listed in [NOTICE](NOTICE).
