import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ssm from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { NestedStackProps, StackConfig } from './configuration';

/**
 * Represents a definition for a task that can be used to generate a task definition
 */
export type TaskConfiguration = {
  memoryLimitMiB?: number,
  cpu?: number,
  desiredCount?: number,
  environment?: Record<string, string>,
  secrets?: Record<string, string>,
}

/**
 * Generator for configuring ECS task definitions for a service
 */
export type EnvFactory = (stage: StackConfig, defaults: Record<string, string>) => TaskConfiguration

/**
 * Generate a fargate service that can be attached to a cluster. This service will include its own
 * load balancer.
 */
export class FargateService extends cdk.NestedStack {

  public readonly service: ecs_patterns.ApplicationLoadBalancedFargateService

  constructor(
    scope: Construct,
    id: string,
    props: NestedStackProps<{
      subDomainWithoutDot?: string,
      healthCheckPath?: string,
      imageVersion?: string,
    }>,
    stack: StackConfig,
    cluster: ecs.ICluster,
    certificate: acm.ICertificate,
    zone: route53.IHostedZone,
    repository: ecr.IRepository,
    taskConfiguration: TaskConfiguration,
  ) {
    super(scope, id, props);

    const subDomainWithoutDot = new cdk.CfnParameter(this, 'subDomainWithoutDot', {
      type: 'String',
      description: 'Subdomain to map to this service (including trailing dot if any)',
      default: '',
    });

    const healthCheckPath = new cdk.CfnParameter(this, 'healthCheckPath', {
      type: 'String',
      description: 'Path to health check url',
      default: '/health-check',
    })

    const imageVersion = new cdk.CfnParameter(this, 'imageVersion', {
      type: 'String',
      description: 'Docker image version to use',
      default: 'latest',
    })

    // Compile secrets into list of mapped ecs.Secrets
    const secrets: { [key: string]: ecs.Secret } = {};
    const secretValues = taskConfiguration.secrets
    if (secretValues) {
      for (const secretKey in Object.keys(secretValues)) {
        // Convert from json string to ecs.Secret
        const value = secretValues[secretKey]
        const [ secretName, fieldName ] = value.split(':').slice(0, 2)
        const secret = ssm.Secret.fromSecretNameV2(
          this,
          secretKey,
          secretName
        )
        secrets[secretKey] = ecs.Secret.fromSecretsManager(secret, fieldName)
      }
    }

    this.service = new ecs_patterns.ApplicationLoadBalancedFargateService(this, stack.getResourceID("AdminService"), {
      cluster: cluster,
      certificate: certificate,
      redirectHTTP: true,
      memoryLimitMiB: taskConfiguration?.memoryLimitMiB || 512,
      cpu: taskConfiguration?.cpu || 256,
      desiredCount: taskConfiguration?.desiredCount || 1,
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(repository, imageVersion.valueAsString),
        environment: taskConfiguration?.environment || {},
        secrets,
      },
    });

    const taskDefinition = this.service.taskDefinition;

    taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage'
        ],
        resources: [ repository.repositoryArn ],
      })
    );

    // Allow secrets
    taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [ "secretsmanager:GetSecretValue" ],
        resources: [ `${ stack.getSecretBaseArn() }/*` ],
      })
    );

    // Health check
    this.service.targetGroup.configureHealthCheck({
      path: healthCheckPath.valueAsString
    });

    // create A recordset alias targeting admin service's load balancer
    const recordName = cdk.Fn.join('', [
      subDomainWithoutDot.valueAsString,
      zone.zoneName
    ])
    new route53.ARecord(this, stack.getResourceID('Recordset'), {
      recordName,
      zone,
      target: {
        aliasTarget: new targets.LoadBalancerTarget(this.service.loadBalancer)
      }
    });

  }
}
