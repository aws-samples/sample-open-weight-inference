import bedrock from '../assets/aws-icons/amazon-bedrock.svg';
import sagemaker from '../assets/aws-icons/amazon-sagemaker-ai.svg';
import ec2 from '../assets/aws-icons/amazon-ec2.svg';
import eks from '../assets/aws-icons/amazon-eks.svg';
import batch from '../assets/aws-icons/aws-batch.svg';

const SERVICES = {
  bedrock: { source: bedrock, name: 'Amazon Bedrock' },
  sagemaker: { source: sagemaker, name: 'Amazon SageMaker AI' },
  ec2: { source: ec2, name: 'Amazon EC2' },
  eks: { source: eks, name: 'Amazon Elastic Kubernetes Service' },
  batch: { source: batch, name: 'AWS Batch' },
} as const;

export type AwsService = keyof typeof SERVICES;

/** Official, unmodified AWS artwork, bundled locally with the application. */
export function AwsServiceIcon({ service }: { service: AwsService }) {
  const { source, name } = SERVICES[service];
  return <img src={source} alt={name} title={name} width={44} height={44} draggable={false} />;
}
