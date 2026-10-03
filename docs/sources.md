# Sources and evidence

EDDIE separates published information, calculated estimates and measured results.
A model listing does not establish account access; a hardware specification does
not establish throughput; a price does not establish feasibility.

| Information | Source |
|---|---|
| Native model discovery | [Bedrock model catalog API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html) |
| Import prerequisites | [Bedrock Custom Model Import](https://docs.aws.amazon.com/bedrock/latest/userguide/custom-model-import-prereq.html) |
| Import billing | [CMI cost calculation](https://docs.aws.amazon.com/bedrock/latest/userguide/import-model-calculate-cost.html) |
| Current service prices | [AWS Price List Query API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-price-list-query-api.html), [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/), [SageMaker pricing](https://aws.amazon.com/sagemaker/ai/pricing/) |
| Model identity and geometry | Pinned Hugging Face model metadata and operator-published checkpoint manifests |
| CPU/GPU specifications | [EC2 instance types](https://docs.aws.amazon.com/ec2/latest/instancetypes/ac.html); individual hardware profiles retain their source |
| Batch operation | [AWS Batch](https://docs.aws.amazon.com/batch/latest/userguide/what-is-batch.html) |
| Conversation and streaming | [Strands streaming](https://strandsagents.com/docs/user-guide/concepts/streaming/) and [session management](https://strandsagents.com/docs/user-guide/concepts/agents/session-management/) |
| Optional governed context | [Context Ontology Accelerator](https://github.com/aws/context-ontology-accelerator) |
| Interface and diagram artwork | [Cloudscape](https://cloudscape.design/) and [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) |

The [dated public price fixture](evidence/prices-2026-09-12.json) supports offline
arithmetic examples in [cost-scenarios.json](../examples/cost-scenarios.json).
It includes retrieval dates, SKUs and source catalog hashes. These are historical
public list rates, not current quotes or private account invoices.

The [recorded speech example](../backend/catalog/speech_example.json) documents one
bounded CPU trial of the reviewed Magpie speech recipe. It supports functional feasibility for that
configuration, not real-time performance, production throughput or a controlled
quality comparison. See [compute-planning.md](compute-planning.md) for its limits.

The [inference runbook library](inference-runbooks.md) adds focused procedures with
a per-source registry of review dates, supported claims and limitations. Its
research references inform experiments without becoming project measurements.

Retain source, revision, date, units and assumptions with every result. Re-check
current documentation, prices, license terms and account access before execution.
