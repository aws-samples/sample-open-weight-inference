---
name: evaluate-speech-generation
description: Evaluate offline or streaming text-to-speech with functional acceptance, audio duration, whole-pipeline memory and completion time. Use for bring-your-own speech models such as Magpie TTS, GGUF speech runtimes and CPU feasibility questions.
---
# Evaluate speech generation

**Decision:** Does the exact speech pipeline produce valid audio for the supplied text within the delivery deadline?

Separate offline generation from live voice. A successful batch run is valuable evidence of feasibility, but does not establish first-audio latency or real-time conversational performance.

## Establish the speech task

Record model variant and revision, codec or vocoder, tokenizer files, runtime and its source revision, language, speaker method, text length and desired audio duration. A speech model is usually several artifacts: the model file alone does not produce audio.

Start with functional acceptance: the selected runtime loads the pinned files, accepts the supplied text, returns non-empty audio that decodes completely, reports errors clearly and releases its compute. Record missing or failed outputs too.

When speech quality is a requirement, use voices with appropriate permission, a defined listening rubric and more than one sample. An author's preference over another service is not a controlled quality comparison.

## Measure the correct boundary

Record generated audio duration, synthesis time, first model load, asset staging, provisioning, queue delay and total submission-to-completion time. Real-time factor is synthesis seconds divided by audio seconds under the stated boundary. Lower than one can support faster-than-playback synthesis in that run; it does not alone establish a streaming first-audio SLO.

When `estimate_inference` returns the [recorded speech example](../../../catalog/speech_example.json), the versioned record owns its exact model, runtime, instance, timings and peak memory. Do not duplicate those figures in a skill or substitute them for this project's measurements. That is one observed short run: it does not prove a longer input, p99, concurrency or comparative voice quality.

## Return and revisit

Return the functional result, exact pipeline identity, measured timing/memory boundaries and the next full-length or concurrent test. Keep CPU visible when streaming is not required; require evidence before excluding it.

EDᗡIE can run a bounded SageMaker CPU trial of its reviewed Magpie speech bundle. Other speech models need their own reviewed recipe; a comparison row is not an executable path.

## Sources

- [NVIDIA Magpie TTS Multilingual model card](https://huggingface.co/nvidia/magpie_tts_multilingual_357m)
- [AWS Batch compute environments](https://docs.aws.amazon.com/batch/latest/userguide/compute_environments.html)
- [MLPerf: scenario-specific performance evidence](https://mlcommons.org/benchmarks/inference-datacenter/)
