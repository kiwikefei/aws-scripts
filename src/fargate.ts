import { Construct } from 'constructs'
import * as cdk from 'aws-cdk-lib'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ssm from 'aws-cdk-lib/aws-secretsmanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import { StackConfig } from './configuration'
import { ARecord } from './route53'
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2'

// Default docker image to use
const DEFAULT_IMAGE = 'nginxdemos/hello:latest'

const DEFAULT_VERSION = 'default'

/**
 * Represents a definition for a task that can be used to generate a task definition
 */
export interface TaskConfiguration {
  memoryLimitMiB?: number
  healthCheckGracePeriod?: cdk.Duration
  cpu?: number
  desiredCount?: number
  environment?: Record<string, string>
  secrets?: Record<string, string>
}

/**
 * Generator for configuring ECS task definitions for a service
 */
export type EnvFactory = (
  stack: StackConfig,
  defaults: Record<string, string>,
) => TaskConfiguration

interface FargateServiceProps extends cdk.NestedStackProps {
  subDomainIncludingDot?: string
  healthCheckPath?: string
  /**
   * Set to "default" to run a default image instead of
   * using the provided repository
   */
  imageVersion?: string | 'default'
  stack: StackConfig
  cluster: ecs.ICluster
  certificate: acm.ICertificate
  zone: route53.IHostedZone
  repository: ecr.IRepository
  taskConfiguration: TaskConfiguration
}

/**
 * Generate a fargate service that can be attached to a cluster. This service will include its own
 * load balancer.
 */
export class FargateService extends cdk.NestedStack {
  public readonly service: ecs_patterns.ApplicationLoadBalancedFargateService

  constructor(scope: Construct, id: string, props: FargateServiceProps) {
    super(scope, id, props)

    const {
      healthCheckPath = '/health-check',
      imageVersion = DEFAULT_VERSION,
      subDomainIncludingDot = '',
      stack,
      cluster,
      certificate,
      zone,
      repository,
      taskConfiguration,
    } = props

    // Compile secrets into list of mapped ecs.Secrets
    const secrets: { [key: string]: ecs.Secret } = {}
    const secretValues = taskConfiguration.secrets
    if (secretValues) {
      for (const [secretKey, value] of Object.entries(secretValues)) {
        if (value) {
          // Convert from json string to ecs.Secret
          const [secretName, fieldName] = value.split(':').slice(0, 2)
          const secret = ssm.Secret.fromSecretNameV2(
            this,
            secretKey,
            secretName,
          )
          secrets[secretKey] = ecs.Secret.fromSecretsManager(secret, fieldName)
        }
      }
    }

    // Pick image
    const image =
      imageVersion === DEFAULT_VERSION
        ? ecs.ContainerImage.fromRegistry(DEFAULT_IMAGE)
        : ecs.ContainerImage.fromEcrRepository(repository, imageVersion)

    this.service = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      stack.getResourceID('AdminService'),
      {
        assignPublicIp: true,
        cluster: cluster,
        certificate: certificate,
        redirectHTTP: true,
        memoryLimitMiB: taskConfiguration?.memoryLimitMiB || 512,
        healthCheckGracePeriod:
          taskConfiguration?.healthCheckGracePeriod || cdk.Duration.seconds(60),
        cpu: taskConfiguration?.cpu || 256,
        desiredCount: taskConfiguration?.desiredCount || 1,
        taskImageOptions: {
          image,
          environment: taskConfiguration?.environment || {},
          secrets,
        },
        taskSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
          onePerAz: true,
        },
      },
    )

    // Hack to fix subnets issue
    // https://github.com/aws/aws-cdk/issues/5892#issuecomment-701993883
    const cfnLoadBalancer = this.service.loadBalancer.node
      .defaultChild as elb.CfnLoadBalancer
    cfnLoadBalancer.subnets = cluster.vpc.selectSubnets({
      onePerAz: true,
      subnetType: ec2.SubnetType.PUBLIC,
    }).subnetIds

    const taskDefinition = this.service.taskDefinition

    taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: [repository.repositoryArn],
      }),
    )

    // Allow secrets
    taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`${stack.getSecretBaseArn()}/*`],
      }),
    )

    // Health check
    this.service.targetGroup.configureHealthCheck({
      path: healthCheckPath,
    })

    // Alias
    new ARecord(this, stack.getResourceID('Record'), {
      subDomainIncludingDot,
      target: route53.RecordTarget.fromAlias(
        new targets.LoadBalancerTarget(this.service.loadBalancer),
      ),
      stack,
      zone,
    })
  }
}
