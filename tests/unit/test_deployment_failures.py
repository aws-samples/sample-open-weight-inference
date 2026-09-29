"""Failure evidence must survive teardown without retaining credentials."""
from deploy.failures import endpoint_failure, provider_diagnostic


def test_image_startup_failure_has_actionable_explanation():
    error = endpoint_failure("Failed", "Failed to download Docker image from Amazon ECR.")
    assert error.code == "serving_image_unavailable"
    assert "image" in error.explanation
    assert "Failed to download Docker image" in error.diagnostic


def test_provider_diagnostic_omits_urls_authentication_and_multiline_injection():
    # Generate a synthetic identifier; no credential belongs in this fixture.
    dummy_access_key_id = "AKIA" + "0" * 16
    diagnostic = provider_diagnostic(
        "Download failed https://example.test/layer?X-Amz-Signature=do-not-store "
        "Authorization: Bearer do-not-store-either "
        f"{dummy_access_key_id} password=secret-value\nfor this model"
    )
    assert "do-not-store" not in diagnostic
    assert "secret-value" not in diagnostic
    assert "AKIA" not in diagnostic
    assert "\n" not in diagnostic
    assert "Download failed" in diagnostic
    assert len(provider_diagnostic("a" * 10000)) <= 1500


def test_capacity_failure_does_not_claim_the_model_is_incompatible():
    error = endpoint_failure("Failed", "Insufficient capacity for ml.g5.2xlarge.")
    assert error.code == "capacity_unavailable"
    assert "capacity" in error.explanation
