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
    expect(bucketsWrittenBy('ChatFunction')).toEqual([]);
  });

  test('kb-source is the resting point: nothing but post-process writes it, and the knowledge base only reads it', () => {
    for (const prefix of ['StartParseFunction', 'IngestFunction', 'ChatFunction']) {
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
  test('FIFO queue serializes ingestion jobs and failures land in a dead-letter queue', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      FifoQueue: true,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
  });

  test('visibility timeout is at least the ingest lambda timeout', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.anyValue(),
      VisibilityTimeout: 360,
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
    });
  });

  test('post-process can enqueue but not consume, ingest can consume', () => {
    expect(actionsOf(policyStatementsFor('PostProcessFunction'))).toContain('sqs:SendMessage');
    expect(actionsOf(policyStatementsFor('PostProcessFunction'))).not.toContain('sqs:ReceiveMessage');
    expect(actionsOf(policyStatementsFor('IngestFunction'))).toContain('sqs:ReceiveMessage');
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

  test('chat lambda can retrieve and converse but cannot write documents or start parsing', () => {
    const actions = actionsOf(policyStatementsFor('ChatFunction'));
    expect(actions).toEqual(
      expect.arrayContaining(['bedrock:Retrieve', 'bedrock:InvokeModelWithResponseStream']),
    );
    expect(actions).not.toContain('bedrock:InvokeDataAutomationAsync');
    expect(actions).not.toContain('bedrock:StartIngestionJob');
    expect(actions.filter((action) => /^s3:(Put|Delete|Abort)/.test(action))).toEqual([]);
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

describe('lambda defaults', () => {
  test('pipeline functions all have a log group with one week retention', () => {
    const functionCount = Object.keys(template.findResources('AWS::Lambda::Function')).filter((id) =>
      /^(StartParse|PostProcess|Ingest|Chat)Function/.test(id),
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
    for (const prefix of ['StartParseFunction', 'PostProcessFunction', 'IngestFunction', 'ChatFunction']) {
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
