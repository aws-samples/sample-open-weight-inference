---
name: evaluate-speech-generation
description: Evaluate offline or streaming text-to-speech with listening criteria, audio duration, whole-pipeline memory and completion time. Use for Qwen3-TTS, podcast generation and CPU feasibility questions.
---
# Evaluate speech generation

**Decision:** Does the exact speech pipeline meet listener needs and the delivery deadline?

Separate offline generation from live voice. A successful batch run is valuable evidence of feasibility, but does not establish first-audio latency or real-time conversational performance.

## Establish the speech task

Record model variant, language, speaker method, text length and desired audio duration. Base, CustomVoice and VoiceDesign are distinct artifacts and interfaces. Identify the tokenizer, acoustic/audio components and reference assets that actually load.

Use voices and reference audio with appropriate permission. For evaluation, listen for pronunciation, intelligibility, skipped or repeated content, speaker consistency and artifacts. Use a defined rubric and more than one sample. An author's preference over another service is not a controlled quality comparison.

## Measure the correct boundary

Record generated audio duration, synthesis time, first model load, asset staging, provisioning, queue delay and total submission-to-completion time. Real-time factor is synthesis seconds divided by audio seconds under the stated boundary. Lower than one can support faster-than-playback synthesis in that run; it does not alone establish a streaming first-audio SLO.

Use `estimate_inference` to read the [bundled CPU example](../../../catalog/podcast_example.json) when a concrete illustration is useful. The versioned record owns its exact models, worker configuration, timings and peak memory. Do not duplicate those figures in a skill or substitute them for this project's measurements.

That is one observed short run. It supports a CPU experiment for offline work. It does not prove a full-episode deadline, p99, concurrency, Graviton performance or comparative voice quality.

## Return and revisit

Return listening results, exact pipeline identity, measured timing/memory boundaries and the next full-length or concurrent test. Keep CPU visible when streaming is not required; require evidence before excluding it.

EDᗡIE can expose CPU planning candidates and this recorded example. It cannot launch the podcast's Batch implementation through its bounded SageMaker trial.

## Sources

- [Qwen3-TTS Base model card and variant interfaces](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base)
- [AWS Batch compute environments](https://docs.aws.amazon.com/batch/latest/userguide/compute_environments.html)
- [MLPerf: scenario-specific performance evidence](https://mlcommons.org/benchmarks/inference-datacenter/)
