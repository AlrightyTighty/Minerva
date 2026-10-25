#!/opt/homebrew/opt/node/bin/node
import * as cdk from 'aws-cdk-lib/core';
import { BackendStack } from '../lib/infra-stack';

const app = new cdk.App();
const alertEmail = app.node.tryGetContext('alertEmail') ?? process.env.ALERT_EMAIL;
if (!alertEmail) {
  throw new Error('Set the budget alert email with `-c alertEmail=you@example.com` or ALERT_EMAIL');
}

new BackendStack(app, 'BackendStack', {
  alertEmail,
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});
