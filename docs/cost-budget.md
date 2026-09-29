# Costs and cleanup

Installing EDDIE creates billable AWS resources. The total has three parts:

| Cost | What drives it |
|---|---|
| Application platform | CloudFront/WAF, AgentCore, DynamoDB, Lambda, KMS, logs, images, artifacts and supporting networking |
| Advisor | Bedrock input/output tokens and runtime use for each conversation turn |
| Inference experiments | Allocated instances or model copies, startup, idle time, storage, requests and data transfer |

An optional COA installation has separate graph, container, search and network
costs. It is disabled by default. Stopping compute does not remove endpoint,
storage or networking charges; Neptune may automatically restart a stopped
cluster after its service-defined interval.

Workshop provisioning also creates a Secrets Manager secret and a dedicated KMS
key for the participant's temporary password; storage, key and request charges apply.

## Compare the same work

Use the same period, completed workload and service objective across options.
Include startup, model loading, idle allocation, retries and shutdown. A per-job
CPU subtotal cannot be compared directly with a continuously allocated monthly
GPU endpoint. Missing costs remain missing, rather than becoming zero.

The [cost model](cost-model.md) explains the formulas and dated arithmetic
fixtures. The [compute planner](compute-planning.md) distinguishes sourced prices,
assumptions and measurements. Neither is a guaranteed AWS bill. Set an AWS Budget
and inspect Cost Explorer for your actual account; alerts do not stop resources.

## Remove resources deliberately

1. In **Deploy & monitor**, request removal of each trial and wait for
   **Removal confirmed**. A closed browser, a removal request or an expired record
   does not establish that billing stopped.
2. Inspect any failed, orphaned or retained resources before removing their
   controllers. Resolve cleanup failures while the application is available.
3. Review the teardown options, then run it with the correct account credentials,
   environment and Region:

```bash
./destroy.sh --help
./destroy.sh --environment dev --region us-east-1
```

[destroy.sh](../destroy.sh) asks for confirmation, inventories inference resources
and reports residuals. It does not automatically delete every discovered model
or endpoint. The artifact bucket is retained by default; `--delete-artifacts`
requests its removal. Versioned objects can require additional cleanup.

KMS keys, encrypted backups, logs, images and separately installed services can
remain after stack deletion. Review CloudFormation retention policies and the
script's residual report; empty that inventory only after verifying each item.
Teardown can delete project history and identities, so export anything you need
before confirming it. Deleting the application is not proof of a zero bill.
