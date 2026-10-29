import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BackendStack } from '../lib/infra-stack';

let template: Template;

beforeAll(() => {
  // skip esbuild bundling, the handlers are only checked at deploy time
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new BackendStack(app, 'TestStack', {
    alertEmail: 'alerts@example.com',
    env: { account: '123456789012', region: 'us-east-1' },
  });
  template = Template.fromStack(stack);
});

const functionByLogicalPrefix = (prefix: string) => {
  const functions = template.findResources('AWS::Lambda::Function');
  const id = Object.keys(functions).find((key) => key.startsWith(prefix));
  if (!id) throw new Error(`No function with logical id starting with ${prefix}`);
  return { id, resource: functions[id] };
};

const policyStatementsFor = (functionPrefix: string): any[] => {
  const { resource } = functionByLogicalPrefix(functionPrefix);
  const roleId = resource.Properties.Role['Fn::GetAtt'][0];
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((policy: any) => policy.Properties.Roles.some((role: any) => role.Ref === roleId))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
};

const actionsOf = (statements: any[]): string[] =>
  statements.flatMap((statement) => [statement.Action].flat());

const bucketId = (prefix: string): string => {
  const id = Object.keys(template.findResources('AWS::S3::Bucket')).find((key) => key.startsWith(prefix));
  if (!id) throw new Error(`No bucket with logical id starting with ${prefix}`);
  return id;
};

const OBJECT_WRITE_ACTIONS = ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'];

const grantsObjectWrite = (statement: any): boolean =>
  [statement.Action].flat().some((granted: string) => {
    const pattern = new RegExp(`^${granted.replace(/\*/g, '.*')}$`);
    return OBJECT_WRITE_ACTIONS.some((action) => pattern.test(action));
  });

// logical ids of the buckets a function's role can write objects to (a wildcard resource counts as every bucket)
const bucketsWrittenBy = (functionPrefix: string): string[] => {
  const written = new Set<string>();
  for (const statement of policyStatementsFor(functionPrefix).filter(grantsObjectWrite)) {
    const resource = JSON.stringify(statement.Resource);
    for (const id of Object.keys(template.findResources('AWS::S3::Bucket'))) {
      if (resource === '"*"' || resource.includes(`"${id}"`)) written.add(id);
    }
  }
  return [...written].sort();
};

describe('storage', () => {
  test('creates one bucket per pipeline stage', () => {
    template.resourceCountIs('AWS::S3::Bucket', 4);
  });

  test('buckets use free SSE-S3 encryption, block public access and are destroyed with the stack', () => {
    const buckets = Object.values(template.findResources('AWS::S3::Bucket')) as any[];
    for (const bucket of buckets) {
      const encryption = bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0];
      expect(encryption.ServerSideEncryptionByDefault.SSEAlgorithm).toBe('AES256');
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(bucket.DeletionPolicy).toBe('Delete');
    }
  });

  test('the single table has PK/SK, GSI1 and a ttl attribute', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
        }),
      ],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  });

  test('budget only counts resources tagged for this project', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        FilterExpression: {
          Tags: { Key: 'Project', Values: ['Minerva'], MatchOptions: ['EQUALS'] },
        },
      }),
    });
  });

  test('taggable resources carry the project tag the budget filters on', () => {
    const tagged = { Tags: Match.arrayWith([{ Key: 'Project', Value: 'Minerva' }]) };
    template.hasResourceProperties('AWS::S3::Bucket', tagged);
    template.hasResourceProperties('AWS::DynamoDB::Table', tagged);
    template.hasResourceProperties('AWS::Lambda::Function', tagged);
    template.hasResourceProperties('AWS::SQS::Queue', tagged);
  });

  test('budget alerts by email at the configured limit', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 20, Unit: 'USD' },
      }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'alerts@example.com' }],
        }),
      ]),
    });
  });
});

describe('knowledge base', () => {
  test('vector bucket uses default encryption (no KMS key)', () => {
    template.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
    const [vectorBucket] = Object.values(template.findResources('AWS::S3Vectors::VectorBucket')) as any[];
    expect(vectorBucket.Properties?.EncryptionConfiguration).toBeUndefined();
    template.resourceCountIs('AWS::KMS::Key', 0);
  });

  test('vector index matches the Titan V2 embedding model and keeps chunk text non-filterable', () => {
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      DataType: 'float32',
      Dimension: 1024,
      DistanceMetric: 'cosine',
      MetadataConfiguration: {
        NonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
      },
    });
  });

  test('knowledge base stores vectors in S3 Vectors, never OpenSearch Serverless', () => {
    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      KnowledgeBaseConfiguration: {
        Type: 'VECTOR',
        VectorKnowledgeBaseConfiguration: {
          EmbeddingModelArn: Match.anyValue(),
          EmbeddingModelConfiguration: {
            BedrockEmbeddingModelConfiguration: { Dimensions: 1024, EmbeddingDataType: 'FLOAT32' },
          },
        },
      },
      StorageConfiguration: {
        Type: 'S3_VECTORS',
        S3VectorsConfiguration: { IndexArn: Match.anyValue() },
      },
    });
    template.resourceCountIs('AWS::OpenSearchServerless::Collection', 0);
    const [knowledgeBase] = Object.values(template.findResources('AWS::Bedrock::KnowledgeBase')) as any[];
    expect(JSON.stringify(knowledgeBase.Properties.KnowledgeBaseConfiguration)).toContain(
      'foundation-model/amazon.titan-embed-text-v2:0',
    );
  });

  test('knowledge base role can only be assumed by Bedrock in this account', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'bedrock.amazonaws.com' },
            Condition: {
              StringEquals: { 'aws:SourceAccount': '123456789012' },
              ArnLike: { 'aws:SourceArn': Match.anyValue() },
            },
          }),
        ],
      },
    });
  });

  test('knowledge base role trust is scoped to knowledge bases', () => {
    const role = Object.values(template.findResources('AWS::IAM::Role')).find((r: any) =>
      JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('bedrock.amazonaws.com'),
    ) as any;
    const condition = role.Properties.AssumeRolePolicyDocument.Statement[0].Condition;
    expect(JSON.stringify(condition.ArnLike['aws:SourceArn'])).toContain(':knowledge-base/*');
  });

  test('data source uses the default parser, explicit chunking and the DELETE policy', () => {
    template.hasResourceProperties('AWS::Bedrock::DataSource', {
      DataDeletionPolicy: 'DELETE',
      DataSourceConfiguration: {
        Type: 'S3',
        S3Configuration: Match.objectLike({ InclusionPrefixes: ['kb-source/'] }),
      },
      VectorIngestionConfiguration: {
        ChunkingConfiguration: {
          ChunkingStrategy: 'FIXED_SIZE',
          FixedSizeChunkingConfiguration: { MaxTokens: 300, OverlapPercentage: 20 },
        },
      },
    });
    // a parsing configuration would pay for every page a second time
    template.hasResource('AWS::Bedrock::DataSource', {
      Properties: {
        VectorIngestionConfiguration: Match.not(Match.objectLike({ ParsingConfiguration: Match.anyValue() })),
      },
    });
  });
});

describe('bedrock data automation', () => {
  test('project is async, standard Markdown output with the optional extras disabled', () => {
    template.hasResourceProperties('AWS::Bedrock::DataAutomationProject', {
      ProjectType: 'ASYNC',
      StandardOutputConfiguration: {
        Document: {
          Extraction: {
            Granularity: { Types: ['DOCUMENT', 'PAGE'] },
            BoundingBox: { State: 'DISABLED' },
          },
          GenerativeField: { State: 'DISABLED' },
          OutputFormat: {
            TextFormat: { Types: ['MARKDOWN'] },
            AdditionalFileFormat: { State: 'DISABLED' },
          },
        },
      },
    });
  });

  test('project has no custom output (blueprints cost 4x per page)', () => {
    template.hasResource('AWS::Bedrock::DataAutomationProject', {
      Properties: Match.not(Match.objectLike({ CustomOutputConfiguration: Match.anyValue() })),
    });
  });
});

describe('pipeline triggers', () => {
  test('only raw/ uploads trigger start-parse', () => {
    template.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          Match.objectLike({
            Events: ['s3:ObjectCreated:*'],
            Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'raw/' }] } },
          }),
        ],
      },
    });
    // exactly one bucket has a notification, and it is the raw bucket
    template.resourceCountIs('Custom::S3BucketNotifications', 1);
  });

  test('start-parse is not retried, so a retry cannot start a second billed BDA job', () => {
    const { id } = functionByLogicalPrefix('StartParseFunction');
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      FunctionName: { Ref: id },
      MaximumRetryAttempts: 0,
    });
  });

  test('BDA completion events invoke post-process with limited retries', () => {
    const { id } = functionByLogicalPrefix('PostProcessFunction');
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.bedrock'],
        'detail-type': Match.arrayWith(['Bedrock Data Automation Job Succeeded']),
      },
      Targets: [
        Match.objectLike({
          Arn: { 'Fn::GetAtt': [id, 'Arn'] },
          RetryPolicy: { MaximumRetryAttempts: 1 },
        }),
      ],
    });
  });

  test('start-parse is given the BDA project and profile', () => {
    const { resource } = functionByLogicalPrefix('StartParseFunction');
    const env = resource.Properties.Environment.Variables;
    expect(env.BDA_PROJECT_ARN).toBeDefined();
    expect(JSON.stringify(env.BDA_PROFILE_ARN)).toContain('data-automation-profile/us.data-automation-v1');
  });
});

// raw -> (start-parse, BDA) -> bda-output -> (post-process) -> processed + kb-source (resting point)
// Each stage writes only into the next one, so no write can re-trigger an earlier stage.
// If the flow changes on purpose, these tests should fail and be revisited.
describe('bucket stages never loop', () => {
  test('raw is the only bucket that triggers anything', () => {
    template.resourceCountIs('Custom::S3BucketNotifications', 1);
    const [notification] = Object.values(template.findResources('Custom::S3BucketNotifications')) as any[];
    expect(JSON.stringify(notification.Properties.BucketName)).toContain(bucketId('UserFileBucket'));

    for (const bucket of Object.values(template.findResources('AWS::S3::Bucket')) as any[]) {
      expect(bucket.Properties.NotificationConfiguration).toBeUndefined();
    }
    for (const rule of Object.values(template.findResources('AWS::Events::Rule')) as any[]) {
      expect(rule.Properties.EventPattern.source).not.toContain('aws.s3');
    }
  });

  test('start-parse writes only to bda-output', () => {
    expect(bucketsWrittenBy('StartParseFunction')).toEqual([bucketId('BdaOutputBucket')]);
  });

  test('post-process writes only to processed and kb-source', () => {
    expect(bucketsWrittenBy('PostProcessFunction')).toEqual(
      [bucketId('ProcessedBucket'), bucketId('KbSourceBucket')].sort(),
    );
  });

  test('nothing after post-process writes to any bucket', () => {
    expect(bucketsWrittenBy('IngestFunction')).toEqual([]);
  });

  test('kb-source is the resting point: nothing but post-process writes it, and the knowledge base only reads it', () => {
    for (const prefix of ['StartParseFunction', 'IngestFunction', 'ApiFunction']) {
      expect(bucketsWrittenBy(prefix)).not.toContain(bucketId('KbSourceBucket'));
    }
    const knowledgeBasePolicy = Object.values(template.findResources('AWS::IAM::Policy')).find((policy: any) =>
      JSON.stringify(policy.Properties.Roles).includes('KnowledgeBaseRole'),
    ) as any;
    expect(knowledgeBasePolicy.Properties.PolicyDocument.Statement.filter(grantsObjectWrite)).toEqual([]);
  });

  test('the only follow-up to a BDA job is post-process, and it cannot start another job', () => {
    const rules = Object.values(template.findResources('AWS::Events::Rule')) as any[];
    expect(rules).toHaveLength(1);
    expect(rules[0].Properties.EventPattern.source).toEqual(['aws.bedrock']);
    expect(actionsOf(policyStatementsFor('PostProcessFunction'))).not.toContain('bedrock:InvokeDataAutomationAsync');
  });
});

describe('ingestion queue', () => {
  test('is a standard queue, because delayed re-checks need per-message delay (not supported by FIFO)', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
    for (const queue of Object.values(template.findResources('AWS::SQS::Queue')) as any[]) {
      expect(queue.Properties.FifoQueue).toBeUndefined();
    }
  });

  test('failures land in a dead-letter queue', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
  });

  test('ingest never waits on a job: its timeout is short and the visibility timeout covers it', () => {
    const { resource } = functionByLogicalPrefix('IngestFunction');
    expect(resource.Properties.Timeout).toBeLessThanOrEqual(60);
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.anyValue(),
      VisibilityTimeout: 360,
    });
  });

  test('several uploads can share one ingestion job through a batching window', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      MaximumBatchingWindowInSeconds: 30,
    });
  });

  test('post-process can enqueue but not consume, ingest can consume and re-queue', () => {
    expect(actionsOf(policyStatementsFor('PostProcessFunction'))).toContain('sqs:SendMessage');
    expect(actionsOf(policyStatementsFor('PostProcessFunction'))).not.toContain('sqs:ReceiveMessage');
    expect(actionsOf(policyStatementsFor('IngestFunction'))).toEqual(
      expect.arrayContaining(['sqs:ReceiveMessage', 'sqs:SendMessage']),
    );
  });
});

describe('iam', () => {
  test('ingest lambda can start ingestion jobs only on the knowledge base', () => {
    const statement = policyStatementsFor('IngestFunction').find((s) =>
      [s.Action].flat().includes('bedrock:StartIngestionJob'),
    );
    expect(statement).toBeDefined();
    expect(statement.Resource).toEqual({ 'Fn::GetAtt': ['KnowledgeBase', 'KnowledgeBaseArn'] });
  });

  test('start-parse can invoke post-process (for reused parses) and nothing else', () => {
    const { id: postProcessId } = functionByLogicalPrefix('PostProcessFunction');
    const statement = policyStatementsFor('StartParseFunction').find((s) =>
      [s.Action].flat().includes('lambda:InvokeFunction'),
    );
    expect(statement).toBeDefined();
    expect(JSON.stringify(statement.Resource)).toContain(postProcessId);
    expect(JSON.stringify(statement.Resource)).not.toContain('"*"');

    const { resource } = functionByLogicalPrefix('StartParseFunction');
    expect(resource.Properties.Environment.Variables.POST_PROCESS_FUNCTION_NAME).toEqual({ Ref: postProcessId });
    // post-process must not be able to call back, which would let the pipeline loop
    expect(actionsOf(policyStatementsFor('PostProcessFunction'))).not.toContain('lambda:InvokeFunction');
  });

  test('every job gets the environment its handler requires', () => {
    const required: Record<string, string[]> = {
      StartParseFunction: [
        'TABLE_NAME', 'RAW_BUCKET', 'BDA_OUTPUT_BUCKET', 'BDA_PROJECT_ARN', 'BDA_PROFILE_ARN', 'POST_PROCESS_FUNCTION_NAME',
      ],
      PostProcessFunction: [
        'TABLE_NAME', 'BDA_OUTPUT_BUCKET', 'PROCESSED_BUCKET', 'KB_SOURCE_BUCKET', 'SUMMARY_MODEL_ID', 'INGEST_QUEUE_URL',
      ],
      IngestFunction: ['TABLE_NAME', 'KNOWLEDGE_BASE_ID', 'DATA_SOURCE_ID', 'INGEST_QUEUE_URL'],
    };
    for (const [prefix, names] of Object.entries(required)) {
      const { resource } = functionByLogicalPrefix(prefix);
      expect(Object.keys(resource.Properties.Environment.Variables)).toEqual(expect.arrayContaining(names));
    }
  });

  // Anthropic models are sold through AWS Marketplace, and Bedrock checks the caller's subscriptions when it invokes one
  test.each(['ApiFunction', 'PostProcessFunction'])(
    '%s calls Bedrock models, so it can view Marketplace subscriptions',
    (prefix) => {
      const statement = policyStatementsFor(prefix).find((s) =>
        [s.Action].flat().includes('aws-marketplace:ViewSubscriptions'),
      );
      expect(statement).toBeDefined();
      // Marketplace actions do not support resource-level permissions
      expect(statement.Resource).toBe('*');
    },
  );

  test('no function can create or cancel Marketplace subscriptions, which could commit the account to charges', () => {
    for (const prefix of ['StartParseFunction', 'PostProcessFunction', 'IngestFunction', 'ApiFunction']) {
      const actions = actionsOf(policyStatementsFor(prefix));
      expect(actions).not.toContain('aws-marketplace:Subscribe');
      expect(actions).not.toContain('aws-marketplace:Unsubscribe');
    }
  });

  test('functions that never call models are not given Marketplace access', () => {
    for (const prefix of ['StartParseFunction', 'IngestFunction']) {
      expect(actionsOf(policyStatementsFor(prefix)).filter((action) => action.startsWith('aws-marketplace:'))).toEqual([]);
    }
  });

  test('no policy grants all actions', () => {
    for (const policy of Object.values(template.findResources('AWS::IAM::Policy')) as any[]) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        const actions = [statement.Action].flat();
        expect(actions).not.toContain('*');
        expect(actions.filter((action: string) => action.endsWith(':*') && !action.startsWith('s3:'))).toEqual([]);
      }
    }
  });
});

describe('api', () => {
  // chat replies are streamed, and an HTTP API cannot stream. A REST API can, once the integration is in STREAM mode.
  const apiMethods = () =>
    Object.values(template.findResources('AWS::ApiGateway::Method')).filter(
      (method: any) => method.Properties.HttpMethod !== 'OPTIONS',
    ) as any[];

  test('is a REST API, not an HTTP API, which cannot stream responses', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
  });

  test('sends every request to the API Lambda through its response-streaming invocation', () => {
    const { id } = functionByLogicalPrefix('ApiFunction');
    const methods = apiMethods();
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      const integration = method.Properties.Integration;
      expect(integration.Type).toBe('AWS_PROXY');
      expect(integration.IntegrationHttpMethod).toBe('POST');
      expect(integration.ResponseTransferMode).toBe('STREAM');
      const uri = JSON.stringify(integration.Uri);
      expect(uri).toContain('response-streaming-invocations');
      expect(uri).toContain(id);
    }
  });

  test('covers every path, so every route reaches the app', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{proxy+}' });
    expect(apiMethods().map((method) => method.Properties.HttpMethod)).toContain('ANY');
  });

  test('is a regional endpoint, because edge-optimized ones cut a stream off after 30 seconds of silence', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: { Types: ['REGIONAL'] },
    });
  });

  test('lets API Gateway invoke the API Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'apigateway.amazonaws.com',
    });
  });

  test('the stage is throttled, since the API is public', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          HttpMethod: '*',
          ResourcePath: '/*',
          ThrottlingRateLimit: Match.anyValue(),
          ThrottlingBurstLimit: Match.anyValue(),
        }),
      ]),
    });
  });

  // API Gateway has its own integration timeout, separate from the Lambda's, and it defaults to 29 seconds
  // even in STREAM mode. Left alone, a request that takes 30 seconds (a work plan) is cut off by the gateway
  // while the Lambda carries on with nobody listening.
  test('gives the gateway at least as long as the Lambda, so a slow request is not cut off at 29 seconds', () => {
    const { resource } = functionByLogicalPrefix('ApiFunction');
    const lambdaMillis = resource.Properties.Timeout * 1000;
    const methods = apiMethods();
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(method.Properties.Integration.TimeoutInMillis).toBeGreaterThanOrEqual(lambdaMillis);
    }
  });

  test('lets a reply run longer than the old 29 second limit, within the stream idle timeout', () => {
    const { resource } = functionByLogicalPrefix('ApiFunction');
    expect(resource.Properties.Timeout).toBeGreaterThan(29);
    expect(resource.Properties.Timeout).toBeLessThanOrEqual(300);
  });

  test('gets its table, bucket and mode from the stack, so no resource names are hard-coded in the app', () => {
    const { resource } = functionByLogicalPrefix('ApiFunction');
    const env = resource.Properties.Environment.Variables;
    expect(env.APP_ENV).toBe('production');
    expect(JSON.stringify(env.TABLE_NAME)).toContain('DatebaseTable');
    expect(JSON.stringify(env.RAW_BUCKET)).toContain(bucketId('UserFileBucket'));
  });

  test('also gets what chat needs: the processed bucket, the knowledge base and the chat model', () => {
    const { resource } = functionByLogicalPrefix('ApiFunction');
    const env = resource.Properties.Environment.Variables;
    expect(JSON.stringify(env.PROCESSED_BUCKET)).toContain(bucketId('ProcessedBucket'));
    expect(JSON.stringify(env.KNOWLEDGE_BASE_ID)).toContain('KnowledgeBase');
    expect(env.CHAT_MODEL_ID).toEqual(expect.any(String));
  });

  test('matches course names with the cheap model, not the chat model', () => {
    const { resource } = functionByLogicalPrefix('ApiFunction');
    const env = resource.Properties.Environment.Variables;
    expect(env.MATCH_MODEL_ID).toEqual(expect.any(String));
    expect(env.MATCH_MODEL_ID).not.toEqual(env.CHAT_MODEL_ID);
    // post-process summarises with the same cheap model
    const postProcess = functionByLogicalPrefix('PostProcessFunction').resource.Properties.Environment.Variables;
    expect(env.MATCH_MODEL_ID).toEqual(postProcess.SUMMARY_MODEL_ID);
  });

  test('plans work with the chat model, since planning needs real reasoning, not the cheap one', () => {
    const { resource } = functionByLogicalPrefix('ApiFunction');
    const env = resource.Properties.Environment.Variables;
    expect(env.WORK_PLAN_MODEL_ID).toEqual(env.CHAT_MODEL_ID);
    expect(env.WORK_PLAN_MODEL_ID).not.toEqual(env.MATCH_MODEL_ID);
  });

  test('chat is part of the API, not a separate function', () => {
    const functionIds = Object.keys(template.findResources('AWS::Lambda::Function'));
    expect(functionIds.filter((id) => id.startsWith('ChatFunction'))).toEqual([]);
  });

  test('can use the table, and only presign uploads into the raw bucket (the one place it writes)', () => {
    // the API signs upload URLs, so its role must be allowed to put to the raw bucket. It never puts objects itself.
    expect(bucketsWrittenBy('ApiFunction')).toEqual([bucketId('UserFileBucket')]);

    const actions = actionsOf(policyStatementsFor('ApiFunction'));
    expect(actions).toEqual(
      expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem']),
    );
  });

  test('can read processed Markdown and uploaded images, and nothing else in S3', () => {
    const readable = new Set<string>();
    for (const statement of policyStatementsFor('ApiFunction')) {
      if (![statement.Action].flat().some((action: string) => /^s3:(Get|\*)/.test(action))) continue;
      for (const id of Object.keys(template.findResources('AWS::S3::Bucket'))) {
        if (JSON.stringify(statement.Resource).includes(`"${id}"`)) readable.add(id);
      }
    }
    expect([...readable].sort()).toEqual([bucketId('ProcessedBucket'), bucketId('UserFileBucket')].sort());
  });

  test('can search the knowledge base and call models, on exactly those bedrock actions', () => {
    const bedrock = policyStatementsFor('ApiFunction')
      .flatMap((statement) => [statement.Action].flat())
      .filter((action: string) => action.startsWith('bedrock:'))
      .sort();
    expect(bedrock).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Retrieve']);

    const retrieve = policyStatementsFor('ApiFunction').find((s) => [s.Action].flat().includes('bedrock:Retrieve'));
    expect(retrieve.Resource).toEqual({ 'Fn::GetAtt': ['KnowledgeBase', 'KnowledgeBaseArn'] });
  });

  test('cannot start or run any other stage of the pipeline', () => {
    const actions = actionsOf(policyStatementsFor('ApiFunction'));
    expect(actions.filter((action) => /^(lambda|sqs|events):/.test(action))).toEqual([]);
    expect(actions).not.toContain('bedrock:InvokeDataAutomationAsync');
    expect(actions).not.toContain('bedrock:StartIngestionJob');
  });

  test('exports its URL', () => {
    template.hasOutput('ApiUrl', {});
  });
});

// The JWT signing key is the one secret that decides who can be anyone, so how it is stored is tested closely.
// It is passed to `cdk deploy --parameters`, held by CloudFormation as a masked parameter, kept in Secrets Manager,
// and read by the API Lambda at startup. It is never in a template default, an environment variable or a policy.
describe('jwt signing key', () => {
  const parameter = () => template.toJSON().Parameters?.JwtPrivateKey;
  const secrets = () => Object.entries(template.findResources('AWS::SecretsManager::Secret')) as [string, any][];
  const secretId = () => {
    const [id] = secrets().find(([key]) => key.startsWith('JwtKeySecret')) ?? [];
    if (!id) throw new Error('No JwtKeySecret');
    return id;
  };

  test('is a stack parameter that CloudFormation masks, so it is not shown in the console or its output', () => {
    expect(parameter()).toBeDefined();
    expect(parameter().NoEcho).toBe(true);
    expect(parameter().Type).toBe('String');
  });

  test('has no default, so a deploy without the key fails instead of deploying with a known or empty one', () => {
    expect(parameter()).not.toHaveProperty('Default');
  });

  test('is kept in a Secrets Manager secret whose value comes straight from the parameter', () => {
    const secret = template.findResources('AWS::SecretsManager::Secret')[secretId()];
    expect(secret.Properties.SecretString).toEqual({ Ref: 'JwtPrivateKey' });
  });

  test('is deleted with the stack, like the rest of this development environment', () => {
    expect(template.findResources('AWS::SecretsManager::Secret')[secretId()].DeletionPolicy).toBe('Delete');
  });

  test('is given to the API Lambda as the secret to read, never as the key itself', () => {
    const { resource } = functionByLogicalPrefix('ApiFunction');
    expect(resource.Properties.Environment.Variables.JWT_KEY_SECRET_ARN).toEqual({ Ref: secretId() });
  });

  test('appears nowhere else in the template, so it cannot leak through an environment variable, output or policy', () => {
    const json = JSON.stringify(template.toJSON());
    const references = json.match(/"Ref":"JwtPrivateKey"/g) ?? [];
    // the one place it is used is the secret's value
    expect(references).toHaveLength(1);
    for (const fn of Object.values(template.findResources('AWS::Lambda::Function')) as any[]) {
      expect(JSON.stringify(fn.Properties.Environment ?? {})).not.toContain('JwtPrivateKey');
    }
    expect(template.toJSON().Outputs ?? {}).not.toHaveProperty('JwtPrivateKey');
  });

  test('can be read by the API Lambda, on exactly that secret and nothing else', () => {
    const statement = policyStatementsFor('ApiFunction').find((s) =>
      [s.Action].flat().includes('secretsmanager:GetSecretValue'),
    );
    expect(statement).toBeDefined();
    expect(statement.Resource).toEqual({ Ref: secretId() });
    const actions = actionsOf(policyStatementsFor('ApiFunction')).filter((a) => a.startsWith('secretsmanager:'));
    expect(actions.sort()).toEqual(['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue']);
  });

  test('cannot be read, changed or deleted by any other function', () => {
    for (const prefix of ['StartParseFunction', 'PostProcessFunction', 'IngestFunction']) {
      expect(actionsOf(policyStatementsFor(prefix)).filter((a) => a.startsWith('secretsmanager:'))).toEqual([]);
    }
  });

  test('can never be written by any function', () => {
    const writes = /^secretsmanager:(Put|Update|Delete|Create|Restore|Rotate|Replicate|TagResource|UntagResource)/;
    for (const prefix of ['StartParseFunction', 'PostProcessFunction', 'IngestFunction', 'ApiFunction']) {
      expect(actionsOf(policyStatementsFor(prefix)).filter((a) => writes.test(a))).toEqual([]);
    }
  });
});

describe('lambda defaults', () => {
  test('pipeline functions all have a log group with one week retention', () => {
    const functionCount = Object.keys(template.findResources('AWS::Lambda::Function')).filter((id) =>
      /^(StartParse|PostProcess|Ingest|Api)Function/.test(id),
    ).length;
    expect(functionCount).toBe(4);
    const logGroups = Object.values(template.findResources('AWS::Logs::LogGroup')) as any[];
    expect(logGroups.length).toBeGreaterThanOrEqual(4);
    for (const logGroup of logGroups) {
      expect(logGroup.Properties.RetentionInDays).toBe(7);
      expect(logGroup.DeletionPolicy).toBe('Delete');
    }
  });

  test('every pipeline function gets the shared resource names', () => {
    for (const prefix of ['StartParseFunction', 'PostProcessFunction', 'IngestFunction', 'ApiFunction']) {
      const { resource } = functionByLogicalPrefix(prefix);
      expect(Object.keys(resource.Properties.Environment.Variables)).toEqual(
        expect.arrayContaining(['TABLE_NAME', 'KNOWLEDGE_BASE_ID', 'DATA_SOURCE_ID', 'KB_SOURCE_BUCKET']),
      );
    }
  });
});

describe('outputs', () => {
  test.each(['TableName', 'KnowledgeBaseId', 'DataSourceId', 'BdaProjectArn', 'KbSourceBucketName'])(
    'exports %s for manual testing',
    (name) => {
      template.hasOutput(name, {});
    },
  );
});
