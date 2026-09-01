#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ClawdJumpStack } from '../lib/clawd-jump-stack';

const app = new cdk.App();
new ClawdJumpStack(app, 'ClawdJumpStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
