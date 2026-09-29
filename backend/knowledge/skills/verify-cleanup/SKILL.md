---
name: verify-cleanup
description: Verify that inference trial resources were actually removed and identify retained assets or ongoing charges. Use when deletion was requested, a worker finished, a stack was removed or a project-history entry disappeared.
---
# Verify cleanup and remaining charges

**Decision:** Has the experiment stopped consuming the resources it was meant to remove?

Use the experiment's resource manifest and account/Region scope. Removing a project-history entry does not delete an endpoint, worker or storage object.

## Check each resource class

| Resource | Completion evidence |
| --- | --- |
| SageMaker endpoint | Endpoint removal confirmed by the service; asynchronous cleanup accounted for |
| EC2/Batch worker | Worker terminated, related job state resolved and scratch storage disposition checked |
| Imported model or reserved capacity | Serving/storage or reservation state verified under that service's lifecycle |
| Supporting resources | Volumes, networking, logs, images and object storage inventoried |
| Application stack | Stack and resource states checked, including retention policies and failures |

An accepted delete request is not a terminal resource state. CloudFormation can retain resources through policy or failure handling; inspect what remains rather than relying only on disappearance from the default stack list.

Do not delete an execution role before the service finishes cleanup that depends on it. SageMaker endpoint deletion includes asynchronous resource cleanup.

## Preserve intentional records

Keep the agreed evidence and any retained artifacts with an owner and retention deadline. State their possible ongoing charges. A completed Batch job can leave a retained worker or storage behind.

If cleanup fails, capture the resource, state and error. Resume the existing cleanup process; do not create another experiment or obscure the failure with a success message.

## Return

Return removed, retained and unresolved resources, with verification time and the next owner/action. “No model resource was created” is also a valid outcome when supported by the record.

Use EDᗡIE's authorized removal flow for its tracked trials. Removing the entire application is a separate operation described in its deployment documentation. The Advisor cannot assert removal from a runbook or a user's request alone.

## Sources

- [SageMaker endpoint deletion and asynchronous cleanup](https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_DeleteEndpoint.html)
- [CloudFormation deletion and retained resources](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-delete-stack.html)
- [AWS Batch compute environment lifecycle](https://docs.aws.amazon.com/batch/latest/userguide/compute_environments.html)
