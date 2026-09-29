"""Cleanup of model files and logs owned by one deployment, including lost replies."""
from __future__ import annotations

import os
import urllib.parse

from .aws_cleanup import _RegionalAdapter, UnknownIdentity, UnsupportedScope, is_not_found
from ..models import LedgerEntry


class ModelArtifactsAdapter(_RegionalAdapter):
    kinds = ("s3-model-artifacts",)
    service = "s3"

    def __init__(self, *, bucket: str = "", **kwargs):
        super().__init__(**kwargs)
        self.bucket = bucket or os.environ.get("EDDIE_ARTIFACT_BUCKET", "")

    def _location(self, entry: LedgerEntry):
        parsed = urllib.parse.urlsplit(self._identity(entry))
        prefix = parsed.path.lstrip("/")
        environment = entry.tags.get("eddie:environment", "")
        expected = f"models/eddie-{environment}/{entry.job_id}/"
        if (parsed.scheme != "s3" or not self.bucket or parsed.netloc != self.bucket
                or parsed.query or parsed.fragment or not environment or prefix != expected):
            raise UnknownIdentity("Artifact cleanup requires this job's exact staging prefix.")
        return parsed.netloc, prefix

    def delete(self, entry: LedgerEntry) -> None:
        s3 = self._scoped_client(entry)
        bucket, prefix = self._location(entry)
        # The recipe is bounded to a small file set. Truncated inventories are not
        # called clean; subsequent sweeps finish without an unbounded Lambda.
        result = s3.list_object_versions(Bucket=bucket, Prefix=prefix, MaxKeys=1000)
        objects = [{"Key": item["Key"], "VersionId": item["VersionId"]}
                   for item in result.get("Versions", []) + result.get("DeleteMarkers", [])]
        if objects:
            deleted = s3.delete_objects(Bucket=bucket, Delete={"Objects": objects, "Quiet": True})
            if deleted.get("Errors"):
                raise RuntimeError("One or more staged files could not be removed.")

    def exists(self, entry: LedgerEntry) -> bool:
        s3 = self._scoped_client(entry)
        bucket, prefix = self._location(entry)
        result = s3.list_object_versions(Bucket=bucket, Prefix=prefix, MaxKeys=1)
        return bool(result.get("Versions") or result.get("DeleteMarkers"))


class EndpointLogsAdapter(_RegionalAdapter):
    kinds = ("sagemaker-log-group",)
    service = "logs"

    def _name(self, entry: LedgerEntry) -> str:
        name = self._identity(entry)
        environment = entry.tags.get("eddie:environment", "")
        expected = f"/aws/sagemaker/Endpoints/eddie-{environment}-{entry.job_id}"
        if not environment or name != expected:
            raise UnknownIdentity("Log cleanup requires this job's exact endpoint log group.")
        return name

    def delete(self, entry: LedgerEntry) -> None:
        logs = self._scoped_client(entry)
        name = self._name(entry)
        try:
            tags = logs.list_tags_log_group(logGroupName=name).get("tags", {})
            if tags.get("eddie:job") != entry.job_id:
                raise UnsupportedScope("The log group is not tagged for this deployment.")
            logs.delete_log_group(logGroupName=name)
        except Exception as exc:
            if not is_not_found(exc, codes=("ResourceNotFoundException",)):
                raise

    def exists(self, entry: LedgerEntry) -> bool:
        logs = self._scoped_client(entry)
        try:
            logs.list_tags_log_group(logGroupName=self._name(entry))
            return True
        except Exception as exc:
            if is_not_found(exc, codes=("ResourceNotFoundException",)):
                return False
            raise
