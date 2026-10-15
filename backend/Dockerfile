# AgentCore Runtime requires an ARM64 container listening on 0.0.0.0:8080 and
# exposing GET /ping and POST /invocations.
# Pin the supported Debian 13 image so a reviewed build cannot silently inherit
# a different operating system. This Python 3.12.15 image includes the Debian
# OpenSSL and PCRE2 security updates available on 2026-10-15. The installer scans
# the resulting runtime image; the base-image pin is not a clean-scan claim.
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app \
    OTEL_SEMCONV_STABILITY_OPT_IN="gen_ai_latest_experimental,gen_ai_unredacted_attributes="

COPY runtime-requirements.txt ./
RUN pip install --no-cache-dir -r runtime-requirements.txt

COPY solver/ ./solver/
COPY catalog/ ./catalog/
COPY evaluation/ ./evaluation/
COPY api/ ./api/
COPY agent/ ./agent/
COPY projects/ ./projects/
COPY knowledge/ ./knowledge/
COPY platform_ops/ ./platform_ops/
COPY deploy/ ./deploy/
COPY netio/ ./netio/
COPY runtime/ ./runtime/

# A non-root user: the runtime needs no write access to the image.
RUN useradd --create-home --uid 10001 eddie && chown -R eddie:eddie /app
USER eddie

EXPOSE 8080

# Single worker: BusyTracker state must be process-local for /ping to be accurate.
CMD ["uvicorn", "runtime.app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
