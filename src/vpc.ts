import { Construct } from 'constructs'
import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { IIpAddresses } from 'aws-cdk-lib/aws-ec2/lib/ip-addresses'

export interface VpcProps extends cdk.NestedStackProps {
  ipAddresses?: IIpAddresses
}

/**
 * Makes a standard VPC with two public and two private subnets
 */
export class Vpc extends cdk.NestedStack {
  public vpc: ec2.Vpc

  constructor(scope: Construct, id: string, props: VpcProps) {
    super(scope, id, props)

    const { ipAddresses = ec2.IpAddresses.cidr('10.0.0.0/16') } = props

    this.vpc = new ec2.Vpc(this, 'VPC', {
      ipAddresses,
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 20,
          name: 'SubnetAPublic',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 20,
          name: 'SubnetAPrivate',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 20,
          name: 'SubnetBPublic',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 20,
          name: 'SubnetBPrivate',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    })
  }
}
