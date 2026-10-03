# Bring a fine-tuned checkpoint

EDDIE can inspect an operator-published checkpoint and compare Bedrock Custom
Model Import with SageMaker for that exact artifact. The public base model is
recorded separately and is never substituted for the fine-tune.

**Status:** implemented and locally tested; AWS deployment and invocation of this
new BYO path have not been verified. The executable recipe targets SageMaker.
Bedrock import is a comparison path; import execution is not implemented.

## Participant workflow

1. In **Your needs**, select **Yes — we have fine-tuned weights**.
2. Open **Models & sources → Your model library**.
3. Choose a prepared checkpoint and select **Read model details**.
4. Check the derived artifact identity, distinct base revision and supplied
   training history. Save the project.
5. Define quality tests and compare hosting. Use **View decision map** to inspect
   compatibility, costs and unresolved checks.
6. In a deployment-enabled installation, review the bounded SageMaker trial.
   Approval must refer to that checkpoint's exact manifest and source versions.

Changing a checkpoint invalidates evidence for the old artifact. Six supplied
answers or an architecture match do not establish the fine-tune's quality,
runtime compatibility, latency or capacity.

## Supported artifact contract

The first recipe accepts complete or merged Qwen2.5 checkpoints derived from a
pinned 0.5B, 1.5B or 7B base, up to eight billion stored parameters and 18 GiB of
files. It requires BF16 Safetensors, Qwen2ForCausalLM configuration, tokenizer and
chat template. Files, tensor shapes, shard indexes, sizes and hashes are checked.

Adapter-only exports, pickle weights, executable model code, remote-code loading,
unrecognized files in a manifest and arbitrary model URLs are not supported by
this recipe. An adapter must be merged with its exact base and exported before
publication. Other architectures need separately reviewed serving recipes.

The executable teaching profile uses one `ml.g5.2xlarge`, the installation's
reviewed serving image and private network. Its bounded context/concurrency
settings are experiment limits, not a production sizing recommendation.

## Prepare the library as the installation operator

Use `scripts/publish_checkpoint.py` with EDDIE's Python environment. The default
mode only validates local files and prints a content identity:

```bash
python scripts/publish_checkpoint.py \
  --directory /path/to/complete-checkpoint \
  --description /path/to/checkpoint-description.json
```

The description supplies these fields. Replace the placeholders with actual
training evidence; no model training is performed by the publisher.

```json
{
  "name": "Acme Catalog — teaching fine-tune",
  "artifactFormat": "merged-checkpoint",
  "baseModel": {
    "source": "Qwen/Qwen2.5-1.5B-Instruct",
    "revision": "<actual 40-character base commit>"
  },
  "lineage": {
    "trainingRun": "<actual training run reference>",
    "trainingDataSha256": "<actual 64-character dataset SHA-256>"
  },
  "license": {
    "id": "<applicable checkpoint terms>",
    "url": "https://example.com/your-checkpoint-terms"
  }
}
```

To publish, explicitly select the installation's account/profile, Region,
artifact bucket and **EDDIE data KMS key**. Use values from that installation,
not values from a screenshot or another application.

```bash
python scripts/publish_checkpoint.py \
  --directory /path/to/complete-checkpoint \
  --description /path/to/checkpoint-description.json \
  --profile YOUR_PROFILE --account YOUR_ACCOUNT_ID --region us-east-1 \
  --bucket YOUR_EDDIE_ARTIFACT_BUCKET --kms-key YOUR_EDDIE_DATA_KEY_ARN \
  --environment YOUR_ENVIRONMENT --id acme-catalog-teaching \
  --publish
```

Publication checks the active account, bucket owner, enabled versioning and all
four S3 public-access blocks. Objects use SSE-KMS and SHA-256 checksums. The
manifest is published last and pins each actual S3 version. Publication creates
storage, not an inference endpoint.

Without `--project`, the checkpoint is shared with authenticated users of this
installation. `--project` restricts it to the server's authenticated project
namespace; it is not a display name or browser-supplied case identifier. Use the
namespace established by your identity configuration.

The generated path is beneath
`checkpoints/eddie-<environment>/<scope>/<checkpoint-id>/<content-id>/`.
The displayed manifest digest includes S3 object versions, so it is distinct from
the local pre-publication content identity.

## Access, verification and lifecycle

The server verifies identity and namespace before any S3 read. A browser cannot
choose another bucket, execution role or container image. Inspection reads
configuration and tensor headers; the stager verifies full file hashes against
the approved manifest before preparing the model.

The new library grants are limited to the installation's checkpoint prefix.
The application can read the library; publication remains an operator action.
Trial resources use the existing approval, resource-ledger and independent
expiry/cleanup mechanisms. Removing a trial does not remove a shared checkpoint.

The publisher may leave versioned files if an upload is interrupted before the
manifest is committed. The operator owns inventory and cleanup of unpublished
or obsolete library versions. Do not remove versions referenced by active plans
or retained evaluation records.

Before offering live workshop trials, verify this exact path in a participant
sandbox: private S3 publication, inspection, approval, authenticated invocation,
rejected anonymous access, expiry and confirmed cleanup. Local tests and a
previous stock-model trial do not establish those properties for a fine-tune.

## Service documentation

- [Bedrock Custom Model Import](https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html)
- [Import prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/custom-model-import-prereq.html)
- [Import cost calculation](https://docs.aws.amazon.com/bedrock/latest/userguide/import-model-calculate-cost.html)
- [SageMaker inference](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model.html)

## Published speech bundle

The model library also accepts one reviewed published artifact: **NVIDIA Magpie TTS
Multilingual v2607**, as a GGUF model, its Nano Codec decoder and ten tokenizer files
plus the required NVIDIA licence and notice
([file manifest](../backend/deploy/magpie-v2607.json)). Every file must match the
pinned size and SHA-256; any other file set is a different recipe. It is recorded
as published and unchanged, with no training lineage.

- Build the bundle from its pinned public sources with
  `scripts/workshop/speech_bundle.py --output magpie-tts-v2607.tar.gz`. It reads the
  tokenizer from two byte ranges of the `.nemo` archive and never downloads the full
  checkpoint.
- Validate a directory with `scripts/publish_checkpoint.py --directory DIR --speech-bundle`,
  and add `--publish ...` as for a checkpoint.
- `./deploy.sh --enable-speech` builds and scans the Magpie-only CPU image
  (`backend/speech-runtime/`, linux/arm64). A bounded trial then runs on one
  `ml.m6g.xlarge` SageMaker endpoint, accepts up to 200 characters per request and
  returns a WAV that the service decodes before returning it. Text and audio are not stored.

Custom Model Import and the GPU text recipes are reported as ruled out for this artifact:
import accepts supported text and vision-language Safetensors models, and the GPU recipes
load Transformers checkpoints.
