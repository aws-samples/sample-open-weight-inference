"""Public documentation queries, never interpolated with conversation data.

These are discovery topics, not cached service limits or capability assertions.
Changing the topic vocabulary is an ordinary reviewed source change.
"""
from types import MappingProxyType

TOPICS = MappingProxyType({
    "bedrock-models": ("Bedrock model APIs", "Amazon Bedrock supported foundation models inference profiles model access Regions"),
    "bedrock-import": ("Bedrock Custom Model Import", "Amazon Bedrock Custom Model Import supported architectures prerequisites inference limitations"),
    "bedrock-import-billing": ("Imported-model billing", "Amazon Bedrock Custom Model Import billing model copies scale to zero storage pricing"),
    "bedrock-batch": ("Bedrock batch inference", "Amazon Bedrock batch inference supported models input output requirements"),
    "sagemaker-jumpstart": ("SageMaker JumpStart", "Amazon SageMaker AI JumpStart deploy pretrained models inference fine tuned models"),
    "sagemaker-containers": ("SageMaker serving containers", "Amazon SageMaker AI custom inference container model artifacts endpoint requirements"),
    "sagemaker-serving": ("SageMaker serving options", "Amazon SageMaker AI real time asynchronous serverless batch transform inference options"),
    "sagemaker-scaling": ("SageMaker inference scaling", "Amazon SageMaker AI inference autoscaling inference components scale to zero"),
    "sagemaker-hyperpod": ("SageMaker HyperPod inference", "Amazon SageMaker HyperPod inference deployment orchestration EKS"),
    "ec2-inference": ("EC2 inference compute", "Amazon EC2 accelerated computing instances inference CPU GPU instance types"),
    "eks-inference": ("EKS inference operations", "Amazon EKS machine learning inference GPU scheduling autoscaling"),
    "batch-cpu": ("AWS Batch CPU jobs", "AWS Batch EC2 CPU compute environments job resource requirements"),
    "batch-scheduling": ("AWS Batch scheduling and startup", "AWS Batch job states STARTING RUNNABLE image download startup job timeout"),
    "ecs-fargate": ("Fargate CPU containers", "Amazon ECS AWS Fargate task CPU memory operating system architecture GPU limitations"),
    "lambda-inference": ("Lambda inference constraints", "AWS Lambda container images memory timeout ephemeral storage quotas inference"),
    "graviton-inference": ("Graviton inference compatibility", "AWS Graviton ARM64 machine learning inference containers compatibility"),
    "neuron-inference": ("Neuron inference compatibility", "AWS Neuron inference supported models architectures frameworks deployment"),
    "inference-optimization": ("SageMaker inference optimization", "Amazon SageMaker AI inference optimization recommender speculative decoding quantization"),
    "pricing-meters": ("AWS inference billing meters", "Amazon Bedrock SageMaker AI EC2 inference pricing billing on demand Savings Plans"),
    "quotas-capacity": ("Quota and capacity checks", "Amazon EC2 SageMaker AI service quotas capacity reservations insufficient capacity"),
    "security-networking": ("Inference security and networking", "Amazon Bedrock SageMaker AI inference security VPC encryption IAM private endpoints"),
    "inference-monitoring": ("Inference monitoring", "Amazon SageMaker AI Bedrock inference monitoring CloudWatch latency errors metrics"),
    "deployment-cleanup": ("Inference resource cleanup", "Amazon SageMaker AI delete endpoint endpoint configuration model cleanup charges"),
})
