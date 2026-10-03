"""Planning math must never become benchmark evidence or a deployment decision."""
from decimal import Decimal

import pytest

from catalog.inference_profile import inference_profile
from catalog.accelerators import ACCELERATORS
from catalog import sizing
from solver.inference_sizing import build_sizing_report, memory_layout, validate_settings, GIB


def profile(kimi=False):
    # Numeric subsets of public HF metadata retrieved 2026-09-23.
    if kimi:
        tensors = {"F32": 23040, "BF16": 2514970968, "F8_E4M3": 1023893241856}
        config = {
            "architectures": ["DeepseekV3ForCausalLM"], "num_hidden_layers": 61,
            "num_attention_heads": 64, "num_key_value_heads": 64, "hidden_size": 7168,
            "kv_lora_rank": 512, "qk_rope_head_dim": 64, "n_routed_experts": 384,
            "num_experts_per_tok": 8, "moe_intermediate_size": 2048,
            "first_k_dense_replace": 1, "moe_layer_freq": 1, "max_position_embeddings": 131072,
        }
    else:
        tensors = {"BF16": 7615616512}
        config = {"architectures": ["Qwen2ForCausalLM"], "num_hidden_layers": 28,
                  "num_attention_heads": 28, "num_key_value_heads": 4,
                  "hidden_size": 3584, "max_position_embeddings": 32768}
    return inference_profile({"safetensors": {"parameters": tensors}}, config,
                             source_url="https://huggingface.co/model",
                             config_url="https://huggingface.co/config",
                             repo="moonshotai/Kimi-K2-Instruct" if kimi else "Qwen/Qwen2.5-7B-Instruct",
                             revision="a" * 40)


def request():
    return {"model": {"name": "Qwen test", "architecture": "Qwen2ForCausalLM",
                      "hfRepo": "Qwen/Qwen2.5-7B-Instruct", "weightsExportable": True},
            "workload": {"horizonHours": "720", "requests": "30000",
                         "inputTokensPerRequest": "500", "outputTokensPerRequest": "100"},
            "constraints": {"permittedRegions": ["us-east-1"]}}


def values(report):
    return {m["id"]: m["value"] for group in report["groups"] for m in group["metrics"]}


def test_binary_memory_and_real_gqa_geometry():
    report = build_sizing_report(request(), profile(), {})
    data = values(report)
    assert data["cachePerToken"] == "56"
    assert data["cache"] == "0.21875"
    assert data["tensorParallel"] == "1"
    assert report["hardware"]["instance"] == "g6.2xlarge"
    assert report["performanceMeasured"] is False
    assert report["scope"] == "PLANNING_ONLY"
    assert data["ttft"] is None
    assert data["copies"] is None  # No invented input/decode conversion.
    assert not {"ranked", "winner", "latencyEvidence"} & report.keys()


def test_mixed_precision_counts_and_mla_replication():
    p = profile(kimi=True)
    report = build_sizing_report(request(), p, {"batchSize": "64", "kvDtype": "FP8", "overheadPercent": "10"})
    data = values(report)
    assert p["tensorBytes"] == 1023893241856 + 2 * 2514970968 + 4 * 23040
    assert data["cachePerToken"] == "34.3125"  # KiB, not decimal KB.
    assert data["tensorParallel"] == "8"
    assert report["model"]["repo"] == "moonshotai/Kimi-K2-Instruct"
    assert Decimal(data["physicalMemory"]) > Decimal(data["logicalMemory"])
    assert any("repeats the MLA cache" in item for item in report["limitations"])


def test_gpu_count_rounds_up_to_supported_parallelism_not_seven():
    layout = memory_layout(ACCELERATORS[-1], Decimal(1100) * GIB, Decimal(1) * GIB,
                           profile(kimi=True), Decimal(".1"), True)
    assert layout["tp"] == 8
    assert layout["fits"] is True


def test_unknown_architecture_does_not_borrow_text_cache_formula():
    p = profile()
    p["architecture"] = "Qwen3TTSForConditionalGeneration"
    data = values(build_sizing_report(request(), p, {}))
    assert data["cachePerToken"] is None
    assert data["tensorParallel"] is None
    assert data["roofline"] is None


def test_a_billion_tokens_is_not_a_billion_requests():
    report = build_sizing_report(request(), profile(), {
        "trafficMode": "tokens", "totalTokens": "1000000000", "outputSharePercent": "5",
    })
    data = values(report)
    assert data["requests"] is None
    assert data["outputTokens"] == "50000000"
    assert data["inputTokens"] == "950000000"


def test_zero_traffic_is_preserved_and_missing_prices_never_become_zero():
    r = request()
    r["workload"]["requests"] = "0"
    data = values(build_sizing_report(r, profile(), {}))
    assert data["outputRate"] == "0"
    assert data["nodeCost"] is None
    assert data["hourly"] is None


def test_native_api_does_not_expose_a_fake_gpu():
    r = request()
    r["model"].update(sourceKind="bedrock", weightsExportable=False, architecture="vendor-api")
    report = build_sizing_report(r, None, {})
    assert report["compute"] == "api"
    assert report["hardware"] is None
    assert set(values(report)) == {"requests", "inputTokens", "outputTokens", "inputRate", "outputRate", "equivalentRate"}


def test_batch_cpu_first_and_full_job_time_is_separate_from_audio_speed():
    report = build_sizing_report(request(), None, {
        "workloadKind": "tts", "servingMode": "batch", "jobConcurrency": "1",
        "deadlineSeconds": "1200",
    })
    assert report["compute"] == "cpu"
    assert report["guidance"]["priority"] == "CPU_BENCHMARK_FIRST"
    assert report["guidance"]["qualifiesDeployment"] is False
    example = report["guidance"]["example"]
    assert example["basis"] == "RECORDED_EXAMPLE" and example["architecture"] == "magpietts"
    assert example["synthesisSeconds"] > example["audioSeconds"]  # Slower than playback.
    assert example["requestSeconds"] >= example["synthesisSeconds"]
    assert values(report)["cpuPeak"] is None  # Example is never injected into current inputs.


def test_cpu_observations_remain_supplied_and_billing_includes_allocated_time():
    report = build_sizing_report(request(), None, {
        "computePreference": "cpu", "cpuRuntime": "supported", "deadlineSeconds": "500",
        "cpuPeakGiB": "19.5", "cpuJobSeconds": "565.428", "cpuBillableSeconds": "635",
        "cpuRunReference": "a user-supplied run", "hourlyRateUsd": "1.428",
        "rateDescription": "Recorded example rate; not a current quote",
    })
    data = values(report)
    assert data["cpuWithinDeadline"] == "No"
    assert data["cpuCost"] == "0.251883"
    assert report["guidance"]["qualifiesDeployment"] is False
    metrics = [m for g in report["groups"] for m in g["metrics"]]
    assert next(m for m in metrics if m["id"] == "cpuJob")["basis"] == "SUPPLIED"
    assert report["guidance"]["priority"] == "CPU_DEADLINE_REVIEW"


def test_batch_does_not_make_an_oversized_model_fit_the_cpu_profile():
    report = build_sizing_report(request(), profile(kimi=True), {
        "workloadKind": "batch", "servingMode": "batch", "jobConcurrency": "1",
    })
    assert report["guidance"]["priority"] == "CPU_MEMORY_REVIEW"
    assert "more memory" in report["guidance"]["title"]
    assert report["guidance"]["qualifiesDeployment"] is False


def test_large_interactive_model_still_explores_gpu():
    report = build_sizing_report(request(), profile(kimi=True), {
        "workloadKind": "chat", "servingMode": "interactive", "jobConcurrency": "1",
    })
    assert report["guidance"]["priority"] == "GPU_BENCHMARK"
    assert report["compute"] == "gpu"
    assert values(report)["roofline"] is not None


@pytest.mark.parametrize("settings", [
    {"kvDtype": []}, {"hardwareId": {}}, {"totalTokens": "NaN"},
    {"contextTokens": "-1"}, {"contextTokens": "4.5"}, {"overheadPercent": True},
    {"prefillSpeedup": "0"}, {"workloadKind": "training"},
    {"cpuPeakGiB": "20"}, {"hourlyRateUsd": "2"},
    {"jobConcurrency": "1.5"}, {"totalTokens": "0.5"},
])
def test_invalid_or_unattributed_settings_are_rejected(settings):
    with pytest.raises(ValueError):
        validate_settings(settings)


def test_extreme_allowed_token_counts_do_not_crash_decimal_rendering():
    r = request()
    r["workload"].update(requests="1000000000000000000", inputTokensPerRequest="1000000000")
    assert values(build_sizing_report(r, profile(), {}))["inputTokens"] == "1000000000000000000000000000"


def test_context_limit_checked_before_hardware_choice():
    with pytest.raises(ValueError, match="published limit"):
        build_sizing_report(request(), profile(), {"contextTokens": "65536"})


def test_private_checkpoint_never_inspects_the_public_base(monkeypatch):
    r = request()
    r["model"].update(sourceKind="checkpoint", artifactDigest="b" * 64)
    monkeypatch.setattr(sizing, "public_profile", lambda *_: pytest.fail("private model leaked to registry"))
    monkeypatch.setattr(sizing, "ec2_on_demand_rate", lambda *_: None)
    result = sizing.estimate_inference({"request": r, "settings": {}})
    assert result["model"]["repo"] is None
    assert result["model"]["revision"] == "b" * 64


def test_exact_revision_is_used_and_quote_is_tagged_to_instance(monkeypatch):
    r = request()
    r["model"]["hfCommit"] = "a" * 40
    seen = []
    monkeypatch.setattr(sizing, "public_profile", lambda source, revision: seen.append((source, revision)) or profile())
    monkeypatch.setattr(sizing, "ec2_on_demand_rate", lambda *_: None)
    result = sizing.estimate_inference({"request": r, "settings": {}})
    assert seen == [("Qwen/Qwen2.5-7B-Instruct", "a" * 40)]
    assert result["pricing"] is None
    assert result["request"] == r


def test_untrusted_metadata_types_do_not_escape_profile_parser():
    result = inference_profile({"safetensors": []}, {"architectures": 12}, source_url="source",
                               config_url="config", repo="org/model", revision=None)
    assert result["architecture"] is None
    assert result["tensorBytes"] is None


def test_saved_sizing_drafts_can_be_incomplete_but_cannot_claim_measurements():
    from projects.store import validate_document

    value = {"form": {}, "sizingDraft": {"settings": {"contextTokens": ""}, "report": None}}
    assert validate_document(value) == value
    value["sizingDraft"]["report"] = {"schemaVersion": 1, "scope": "PLANNING_ONLY", "performanceMeasured": True}
    with pytest.raises(ValueError, match="planning report"):
        validate_document(value)


def test_ec2_quote_cannot_use_a_windows_dedicated_or_wrong_region_product(monkeypatch):
    from catalog import pricing

    def product(amount="1.25", **overrides):
        attrs = {
            "instanceType": "c7i.8xlarge", "location": "US East (N. Virginia)",
            "operatingSystem": "Linux", "tenancy": "Shared", "preInstalledSw": "NA",
            "capacitystatus": "Used", "operation": "RunInstances", **overrides,
        }
        return {"product": {"sku": "unit-test-sku", "attributes": attrs}, "terms": {"OnDemand": {
            "term": {"effectiveDate": "2026-09-01", "priceDimensions": {
                "hour": {"unit": "Hrs", "pricePerUnit": {"USD": amount}},
            }},
        }}}

    products = [product("0.01", operatingSystem="Windows"),
                product("0.02", tenancy="Dedicated"),
                product("0.03", location="US West (Oregon)"), product()]
    monkeypatch.setattr(pricing, "_iter_products", lambda *_args, **_kwargs: iter(products))
    quote = pricing.ec2_on_demand_rate("c7i.8xlarge")
    assert quote is not None and quote.amount == Decimal("1.25")
    products.append(product("1.50"))
    assert pricing.ec2_on_demand_rate("c7i.8xlarge") is None


def test_model_task_is_read_from_metadata_instead_of_defaulting_speech_to_text(monkeypatch):
    from catalog import model_inspect

    replies = [
        (200, {"sha": "a" * 40, "pipeline_tag": "text-to-speech", "safetensors": {"total": 1700000000}}),
        (200, {"architectures": ["Qwen3TTSForConditionalGeneration"], "torch_dtype": "float32"}),
        (200, []),
    ]
    monkeypatch.setattr(model_inspect, "_fetch", lambda *_args: replies.pop(0))
    result = model_inspect.inspect_model_source("Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")
    assert result.ok is True
    assert result.modality.value == "TTS"
    assert result.to_json()["fields"]["modality"]["origin"] == "DETECTED"
