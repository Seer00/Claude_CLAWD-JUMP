import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { ClawdJumpStack } from '../lib/clawd-jump-stack';

test('stack has a private bucket, a CloudFront distribution and a site deployment', () => {
  const app = new cdk.App();
  const stack = new ClawdJumpStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  template.resourceCountIs('Custom::CDKBucketDeployment', 1);
});
