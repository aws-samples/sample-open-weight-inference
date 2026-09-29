"""Read-only upgrade preflight for Cognito groups created before CFN managed them."""
import argparse

import boto3
from botocore.exceptions import ClientError

GROUPS = {
    "ReadersGroup": "eddie-readers",
    "UsersGroup": "eddie-users",
    "DeployersGroup": "eddie-deployers",
    "ApproversGroup": "eddie-approvers",
    "OperatorsGroup": "eddie-operators",
}


def provision_groups(resources: list[dict], existing: set[str]) -> bool:
    """Never switch a stack-managed group off: that would delete its memberships."""
    managed = {
        item["LogicalResourceId"] for item in resources
        if item.get("ResourceType") == "AWS::Cognito::UserPoolGroup"
        and item.get("ResourceStatus") != "DELETE_COMPLETE"
    }
    if managed & GROUPS.keys():
        if managed & GROUPS.keys() != GROUPS.keys():
            raise ValueError("Cognito groups have mixed stack ownership; reconcile ownership before updating.")
        return True
    present = existing & set(GROUPS.values())
    if present and present != set(GROUPS.values()):
        raise ValueError("Only some legacy Cognito groups exist; reconcile the five application groups before updating.")
    return not present


def resolve(stack: str, region: str) -> bool:
    cf = boto3.client("cloudformation", region_name=region)
    try:
        pages = cf.get_paginator("list_stack_resources").paginate(StackName=stack)
        resources = [item for page in pages for item in page["StackResourceSummaries"]]
    except ClientError as exc:
        error = exc.response.get("Error", {})
        if error.get("Code") == "ValidationError" and "does not exist" in error.get("Message", ""):
            return True
        raise
    pool = next((item["PhysicalResourceId"] for item in resources
                 if item.get("LogicalResourceId") == "UserPool"
                 and item.get("ResourceStatus") != "DELETE_COMPLETE"), None)
    if not pool:
        return provision_groups(resources, set())
    client = boto3.client("cognito-idp", region_name=region)
    existing = set()
    token = None
    while True:
        page = client.list_groups(UserPoolId=pool, Limit=60, **({"NextToken": token} if token else {}))
        existing.update(group["GroupName"] for group in page.get("Groups", []))
        token = page.get("NextToken")
        if not token:
            break
    return provision_groups(resources, existing)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack", required=True)
    parser.add_argument("--region", required=True)
    args = parser.parse_args()
    print("true" if resolve(args.stack, args.region) else "false")
