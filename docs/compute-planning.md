# Plan an inference experiment

Self-hosting an open-weight model does not require a GPU. Start with the workload,
check compatible runtimes, then test the smallest practical configuration against
quality, memory, latency and cost targets.

In **Compare hosting**, open **Size compute and plan a benchmark**. The same sheet
is available under **View decision map → Compute & evidence**. Manual edits take
effect immediately; **Update sizing sheet** recalculates and **Save project**
preserves the inputs and result. The optional Advisor uses the same backend
calculator and returns its result to this sheet.

## CPU or GPU?

| Workload or constraint | First useful experiment |
|---|---|
| Queued work, one or two concurrent jobs, a flexible completion deadline | CPU, if the complete runtime works and memory is sufficient |
| Embeddings, classification or reranking | A CPU baseline; compare GPU at the required input length and arrival rate |
| Live voice or interactive generation | Measure first output and tail latency. Large models and concurrent generation often need acceleration |
| Weight footprint or observed process memory reaches the CPU profile's RAM | More RAM, a smaller compatible configuration or GPUs; include the OS and all workers |
| A CPU observation exceeds the deadline | Separate startup, loading and generation. Test reuse or faster compute, then repeat the whole job |
| A runtime requires GPU operators | A compatible CPU implementation or a GPU experiment |

There is **no universal parameter-count cutoff**. FP32 weights alone need about
6.3 GiB for 1.7 billion parameters, 26.1 GiB for 7 billion and 260.8 GiB for
70 billion. These are memory floors, not performance predictions. A CPU runtime
can expand BF16 or quantized files, and caches, decoders, temporary allocations
and concurrent models add memory.

| CPU option | Useful when | Check before choosing |
|---|---|---|
| AWS Batch | Work is queued or scheduled | Underlying EC2/Fargate resources, job startup, retry policy and scale-down |
| ECS on Fargate | You want managed CPU containers | Supported CPU/memory shapes, runtime architecture, loading time and task billing |
| EC2 CPU | You need host, instruction-set or memory control | Peak RAM, thread count, model reuse and allocated idle time |
| SageMaker AI CPU | You want managed endpoints or Batch Transform | Container compatibility, supported instance/job modes and payload limits |
| Lambda | The complete task is small and short | Standard-function memory, duration, CPU, package and cold-start limits |

Graviton requires an ARM64 image and compatible native dependencies. Compare
completed work per dollar using its own measurements; an x86 timing does not
establish Graviton performance.

## What the numbers establish

Each metric shows its basis and an expandable explanation, formula or source.

- **Model metadata:** tensor counts, storage dtypes and geometry from a pinned
  Hugging Face revision. These are published metadata, not a download-and-hash
  verification of every weight shard. Stored elements can include buffers/scales.
- **Published specification:** hardware capacity and theoretical performance from
  AWS/NVIDIA documentation. A profile does not confirm regional availability.
- **Assumption or your input:** cached length, batch size, runtime allowance,
  utilization, traffic peaks, CPU observations or a supplied price.
- **Calculated:** reproducible arithmetic from those inputs.
- **Modeled, not measured:** decode estimates and the resulting replica floor.
  They cannot satisfy a performance or deployment gate.
- **Recorded example:** a separate experiment, with its configuration and limits.
  It never becomes a measurement of the current project.

Memory uses **GiB/KiB**; bandwidth sources can use decimal GB/s. GQA cache
calculation accounts for key/value heads. MLA repeats its compressed cache on
each tensor-parallel rank. Tensor-parallel choices are limited to supported
planning degrees and attention-head divisibility; the actual serving engine
still requires validation.

The decode model uses dense BF16 compute and a memory-bandwidth calculation,
including the stated batch size. It omits communication, scheduling, attention
compute and runtime overhead. It also models full weight reads for MoE rather
than predicting expert access. Treat it as a sensitivity model, never measured
throughput or a latency promise.

Fleet arithmetic requires an explicit input-processing/output-generation ratio.
The default placement uses one replica per node; an availability floor is an
input, not proof of multi-AZ resilience. It does not solve multi-node parallelism.
CPU inference has no synthetic tokens-per-second estimate.

Price collection requests the exact EC2 instance, Region, Linux, shared tenancy
and On-Demand hourly product. Missing or ambiguous rates stay unavailable.
SageMaker, Fargate and commitment discounts have separate billing meters.
The existing hosting comparison retains its own service prices and qualification.
For public On-Demand and 1-year/3-year GPU commitment tables, open
[Tokenomics](tokenomics.md). It keeps annual cost, full-term commitment and
upfront payment separate from the model-sizing calculation.

## CPU options in the hosting comparison

**Compare hosting** includes EC2 CPU and AWS Batch on EC2 CPU configurations for
downloadable model files. The initial profile is `c7i.8xlarge`: 32 vCPU and 64 GiB
RAM. It is a benchmark candidate, not an optimized or executable deployment recipe.

With no latency target, CPU stays visible. **Workload and costs for CPU options**
asks about live output, job deadline, concurrency and volume. A GPU-only runtime
or an oversized resident model produces an explicit exclusion; a missing answer
produces a question. The decision map shows those checks for each configuration.

Use a common comparison period and allocation schedule, including startup, loading,
idle time, retries and shutdown. EC2 CPU and SageMaker default to continuous
allocation. Batch has no assumed job schedule. CPU totals also require a sourced
allowance for storage, networking/IP, logs and requests. Until those inputs exist,
the UI shows a partial subtotal and names missing costs. Equal allocation time
does not establish equal completed work: verify throughput before choosing.

Older saved results offer **Include CPU options** to refresh their comparison.
They are preserved as historical results rather than silently recalculated.

## Reproduce the manual checks

### A short speech job on CPU

1. Choose **New project**. Describe a queued text-to-speech job for one supplied
   sentence and one preset voice. In **Your needs**, choose batch delivery and
   enter **1** under **Usage details → Requests at the same time**. Save.
2. Under **Models & sources → Your model library**, choose the Magpie TTS v2607
   bundle and read its details: model, codec and tokenizer files, GGUF format and
   the NeMo-Speech.cpp runtime. Alternatively inspect
   `nvidia/magpie_tts_multilingual_357m`; its GGUF metadata supplies the
   architecture and stored tensor count, and no config.json exists to read.
3. **Compare hosting**. Bedrock import is ruled out for a GGUF speech model, the
   GPU text serving recipes are ruled out on runtime, and the SageMaker Graviton
   CPU endpoint runs the reviewed Magpie recipe. EC2 and AWS Batch CPU profiles
   remain planning options.
4. Open **Size compute and plan a benchmark**. Choose **Batch speech**, one
   simultaneous job and a completion budget, then build the sizing sheet. Read
   the CPU-first guidance and **CPU hosting paths**.
5. If speech trials are enabled, run a bounded trial from **Deploy & monitor**:
   the endpoint returns a WAV that EDDIE decodes before showing it, and records
   input/output hashes, synthesis time, request time and peak process memory.

The [recorded example](../backend/catalog/speech_example.json) is one 182-character
request on one `ml.m6g.xlarge`: 11.6 seconds of audio in 37.3 seconds of synthesis,
893 MiB peak process memory, endpoint ready 217 seconds after approval and removal
confirmed 304 seconds after it was requested. It is not a full-length job, p99, a
concurrency test or a speech-quality evaluation.

### A large text model

Inspect the exact model you intend to serve. The verified browser example uses
`moonshotai/Kimi-K2-Instruct`; it is not evidence about a model named Kimi K3.
Set **Interactive text**, total-token traffic of **1,000,000,000**, an output share
of **5%**, 4,096 cached tokens and 64 sequences. FP8 cache, a 10% runtime allowance
and a prefill ratio of 6 are explicit sensitivity assumptions, not measurements.

The traffic splits into **950 million input and 50 million output tokens**.
Request count remains unknown. The current metadata and shortlist yield a TP-8
memory plan on `p6-b200.48xlarge`; runtime compatibility, actual throughput,
latency, quotas and availability remain unverified.

## Scope and sources

This feature plans existing-model inference, including fine-tuned artifacts.
It does not train models, run arbitrary repository code, launch CPU/Batch jobs,
start a load test or widen the application's approved deployment recipes.

Private checkpoints keep their own identity. The planner does not inspect their
public base and pretend it inspected the fine-tune. Unsupported geometry remains
missing until a compatible artifact profile is available.

- [AWS Batch](https://docs.aws.amazon.com/batch/latest/userguide/what-is-batch.html)
- [Fargate task configuration](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
- [SageMaker Batch Transform](https://docs.aws.amazon.com/sagemaker/latest/dg/batch-transform.html)
- [SageMaker Inference Recommender](https://docs.aws.amazon.com/sagemaker/latest/dg/inference-recommender.html)
- [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [EC2 accelerator specifications](https://docs.aws.amazon.com/ec2/latest/instancetypes/ac.html)
- [Magpie TTS Multilingual](https://huggingface.co/nvidia/magpie_tts_multilingual_357m)
- [Kimi K2](https://huggingface.co/moonshotai/Kimi-K2-Instruct)
