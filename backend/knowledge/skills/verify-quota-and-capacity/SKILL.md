---
name: verify-quota-and-capacity
description: Separate supported instance offerings, applied service quotas, available capacity and capacity actually secured. Use before GPU commitments, SageMaker endpoint deployment, Local Zone selection or interpreting a quota increase.
---
# Verify quota and capacity independently

**Decision:** Can the planned resources be provisioned in the required place and time?

Keep four records separate:

| Record | What it establishes |
| --- | --- |
| Service/instance offering | The configuration is offered in a location |
| Applied account quota | The account's permitted limit for a specific resource scope |
| Capacity observation | A point-in-time allocation or availability result |
| Secured reservation | The matching capacity, start/end window and obligations of a confirmed reservation |

None substitutes for the next. A successful quota increase is not a delivery commitment.

## Verify the requested scope

Record service, instance type, count, Region, Availability Zone or Local Zone, purchase option, required date and runtime compatibility. SageMaker quotas and EC2 quotas are different; quotas can also distinguish endpoint and job types.

Use applied quotas where available and account for existing usage. A default quota page may not reflect this account. Discovery APIs listing instance offerings do not prove spare capacity.

For Local Zones, verify opt-in, supported services/features, networking and artifact access rather than assuming the parent Region's capabilities apply unchanged.

## Check the capacity mechanism

For EC2, evaluate the applicable On-Demand Capacity Reservation or Capacity Block requirements. For SageMaker, check supported inference-capacity mechanisms and their endpoint configuration.

SageMaker documentation uses the name “training plan” for a mechanism that can target inference endpoints. Verify its target resource and active reservation window; this does not turn the workload into training.

## Return and revisit

Return separate quota and capacity statuses, evidence timestamps, required date and next action. Missing evidence remains unresolved in EDᗡIE.

Do not launch expensive instances just to test availability without the normal deployment authorization. A reservation query, requested increase or commercial conversation cannot be reported as capacity secured.

## Sources

- [Applied service quota API](https://docs.aws.amazon.com/servicequotas/2019-06-24/apireference/API_GetServiceQuota.html)
- [Instance type offerings](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstanceTypeOfferings.html)
- [EC2 Capacity Reservations](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-capacity-reservations.html)
- [SageMaker capacity plans for inference endpoints](https://docs.aws.amazon.com/sagemaker/latest/dg/training-plan-utilization-for-inference-endpoints.html)
