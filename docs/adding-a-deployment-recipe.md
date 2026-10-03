# Add a deployment recipe

A **recipe** is the model packaging, serving software, hardware settings and
request/response handling that EDᗡIE uses to run a trial. It is executable
application code, not an Advisor skill or a model name in the catalogue.

Model discovery and hosting estimates cover more configurations than the app can
deploy. A catalogue result can inform a decision even when no deployment recipe
is installed.

## What is included

| Recipe | Model input | Trial configuration |
| --- | --- | --- |
| `sagemaker-qwen-small-vllm` | Published Qwen2.5 0.5B or 1.5B Instruct, pinned to a Hugging Face revision | SageMaker `ml.g5.2xlarge`, GPU vLLM image |
| `byo-qwen2-safetensors` | A compatible Qwen2 checkpoint in the installation's model library | SageMaker `ml.g5.2xlarge`, GPU vLLM image; artifact and size checks apply |
| `sagemaker-magpie-cpu` | The exact published Magpie TTS v2607 bundle, including codec, tokenizer and licence notices | SageMaker `ml.m6g.xlarge`, ARM64 CPU speech image |

The operator must install the matching image and enable trials. Each recipe
reports its own readiness; enabling speech does not enable the GPU recipes.
Bedrock import, EC2 and AWS Batch remain planning paths in this release.

For a checkpoint that already fits the Qwen2 recipe, follow
[Fine-tuned checkpoints](fine-tuned-checkpoints.md). No new recipe is needed.
Adding a different architecture or serving stack requires a code change and
redeployment. There is no arbitrary recipe-upload button.

## Enable an included recipe

Add the appropriate flag to the [installation command](getting-started.md#install):

| Trial | Installer flag |
| --- | --- |
| Qwen text or compatible fine-tuned checkpoint on GPU | `--enable-inference` |
| Magpie speech on CPU | `--enable-speech` |

Use both flags to prepare both runtimes. The installer builds or copies the
serving images, scans them and configures the application. It does not start an
inference endpoint. Image and artifact storage can still incur charges.

For a fine-tuned checkpoint or Magpie, the operator must also
[publish the model files to the installation's library](fine-tuned-checkpoints.md#prepare-the-library-as-the-installation-operator);
Magpie has its own [bundle instructions](fine-tuned-checkpoints.md#published-speech-bundle).
Then select the model in the app and use **Deploy & monitor** to review and approve
the trial. The installed recipe determines its compatibility checks and limits.

## Extend the application

Start with the closest existing recipe and keep the first trial small.

| Step | Implement and verify |
| --- | --- |
| 1. Define the contract | Choose an ID and version. Specify the exact artifact format, compatible architecture, runtime, instance, input/output format, size limits and maximum lifetime. |
| 2. Inspect the artifact | Extend [checkpoint inspection](../backend/deploy/checkpoints.py) or the [published-model recipe](../backend/deploy/recipes.py). Inspect inert metadata; reject remote model code, unexpected files and unsupported formats. Preserve the selected model's identity. |
| 3. Stage verified files | Extend [staging](../backend/deploy/staging.py). Pin source revisions or S3 object versions and verify hashes before use. Reject archive traversal, links and extra files. Include required third-party licences and notices. |
| 4. Package the serving runtime | Follow the existing [GPU image preparation](../scripts/prepare_serving_image.py) or [CPU speech image](../backend/speech-runtime/Dockerfile). Pin dependencies and the image digest; meet SageMaker's health/invocation contract and enforce request, concurrency and wall-clock limits. |
| 5. Connect the lifecycle | Update [recipe readiness](../backend/deploy/recipes.py), [preflight](../backend/deploy/service.py), [execution](../backend/deploy/executor.py) and [response validation](../backend/deploy/inference.py). Use the correct service price and quota. Keep approval, budget, expiry, ownership and cleanup checks. |
| 6. Explain it in the UI | Add compatibility checks to [candidate generation](../backend/catalog/candidates.py) and the supported flow to [TestDeployment](../frontend/src/components/TestDeployment.tsx). Label CPU/GPU explicitly. Show why unsupported inputs are excluded; never silently substitute a model. |
| 7. Validate and install | Test malformed artifacts, wrong versions, missing images, expired approvals, timeouts and cleanup. Check existing Qwen and Magpie flows, rebuild affected images, review IAM changes and deploy the updated app. |

These are code extension points, not a plug-in interface. If the new recipe needs
different AWS permissions, add only those actions and resources to
[CloudFormation](../infra/cloudformation/application/eddie-app.yaml) and run the
existing IAM audit. A browser request must never choose an arbitrary role,
container image, bucket or command.

## Evidence before claiming support

Unit tests establish validation and lifecycle behavior. A bounded trial must also
show that the exact image and model load, return valid output, stay within their
limits, and release their resources. Record model/image identities, workload,
startup and request times separately, memory, cost basis and verified cleanup.
One successful request does not establish production throughput or quality.

Keep downloaded weights, tokenizer assets, datasets, virtual environments and
build output outside Git. Publish model artifacts separately only after reviewing
their applicable terms and your organization's approval requirements. The Magpie
packager copies the required NVIDIA agreement and notice into its model archive;
an older archive without them must be rebuilt and republished.

See [Contributing](../CONTRIBUTING.md) for local checks and
[Security considerations](security-posture.md) for the deployment boundaries.
