import * as path from 'path';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { AttributeType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { CfnDataAutomationProject, CfnDataSource, CfnKnowledgeBase } from 'aws-cdk-lib/aws-bedrock';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption, EventType } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { CfnIndex, CfnVectorBucket } from 'aws-cdk-lib/aws-s3vectors';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    // example resource
    // const queue = new sqs.Queue(this, 'InfraQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}

export interface BackendStackProps extends cdk.StackProps {
  /** Receives the budget alert emails. */
  alertEmail: string;
  /** Monthly budget in USD that triggers the alert. Defaults to 20. */
  budgetLimitUsd?: number;
  /** Bedrock model (or inference profile) id used by the chat Lambda. */
  chatModelId?: string;
  /** Cheap Bedrock model (or inference profile) id used for file summaries. */
  summaryModelId?: string;
  /** BDA cross-region inference profile id. */
  bdaProfileId?: string;
}

const BACKEND_ROOT = path.join(__dirname, '..', '..', 'backend');
const JOBS_SRC = path.join(BACKEND_ROOT, 'src', 'jobs');
const API_SRC = path.join(BACKEND_ROOT, 'src', 'entrypoints');

// Titan Text Embeddings V2 produces 1024 dimensions by default, and the vector index must match.
const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIMENSIONS = 1024;

export class BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps)
  {
    super(scope, id, props)

    const chatModelId = props.chatModelId ?? 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    const summaryModelId = props.summaryModelId ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    const bdaProfileId = props.bdaProfileId ?? 'us.data-automation-v1'

    // step 1: buckets, dynamodb, budget
    // raw, BDA output, processed and KB source are separate buckets so no Lambda
    // can ever write into the bucket that triggers it (recursive trigger = runaway BDA bill)
    const bucketDefaults = {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    }

    const userFileBucket = new Bucket(this, "UserFileBucket", {
      ...bucketDefaults,
    })

    const bdaOutputBucket = new Bucket(this, "BdaOutputBucket", {
      ...bucketDefaults,
    })

    const processedBucket = new Bucket(this, "ProcessedBucket", {
      ...bucketDefaults,
    })

    const kbSourceBucket = new Bucket(this, "KbSourceBucket", {
      ...bucketDefaults,
    })

    const databaseTable = new Table(this, "DatebaseTable",
      {
        partitionKey: {
          name: "PK",
          type: AttributeType.STRING
        },
        sortKey: {
          name: "SK",
          type: AttributeType.STRING
        },
        timeToLiveAttribute: "ttl",
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    )

    databaseTable.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: {
        name: "GSI1PK",
        type: AttributeType.STRING
      },
      sortKey: {
        name: "GSI1SK",
        type: AttributeType.STRING
      }
    })

    new CfnBudget(this, "Budget", {
      budget: {
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: {
          amount: props.budgetLimitUsd ?? 20,
          unit: "USD"
        }
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 75,
            thresholdType: "PERCENTAGE"
          },
          subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }]
        },
        {
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "PERCENTAGE"
          },
          subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }]
        }
      ]
    })

    // step 2: s3 vectors bucket + index, knowledge base, data source
    // default SSE-S3 encryption only, a KMS key costs ~$1/month
    const vectorBucket = new CfnVectorBucket(this, "VectorBucket", {})
    vectorBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY)

    const vectorIndex = new CfnIndex(this, "VectorIndex", {
      indexName: "course-materials",
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      dataType: "float32",
      dimension: EMBEDDING_DIMENSIONS,
      distanceMetric: "cosine",
      metadataConfiguration: {
        // Bedrock stores chunk text here, and it would exceed the filterable metadata limit
        nonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"],
      },
    })
    vectorIndex.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY)

    const embeddingModelArn = `arn:${this.partition}:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL_ID}`

    const knowledgeBaseRole = new Role(this, "KnowledgeBaseRole", {
      assumedBy: new ServicePrincipal("bedrock.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:${this.partition}:bedrock:${this.region}:${this.account}:knowledge-base/*` },
        },
      }),
    })
    knowledgeBaseRole.addToPolicy(new PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [embeddingModelArn],
    }))
    knowledgeBaseRole.addToPolicy(new PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [kbSourceBucket.bucketArn],
      conditions: { StringEquals: { "aws:ResourceAccount": this.account } },
    }))
    knowledgeBaseRole.addToPolicy(new PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [kbSourceBucket.arnForObjects("kb-source/*")],
      conditions: { StringEquals: { "aws:ResourceAccount": this.account } },
    }))
    knowledgeBaseRole.addToPolicy(new PolicyStatement({
      actions: [
        "s3vectors:GetIndex",
        "s3vectors:QueryVectors",
        "s3vectors:PutVectors",
        "s3vectors:GetVectors",
        "s3vectors:DeleteVectors",
      ],
      resources: [vectorIndex.attrIndexArn],
    }))

    const knowledgeBase = new CfnKnowledgeBase(this, "KnowledgeBase", {
      name: `${this.stackName}-course-materials`,
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: EMBEDDING_DIMENSIONS,
              embeddingDataType: "FLOAT32",
            },
          },
        },
      },
      // explicit S3 Vectors, never the OpenSearch Serverless default (~$350/month idle)
      storageConfiguration: {
        type: "S3_VECTORS",
        s3VectorsConfiguration: {
          indexArn: vectorIndex.attrIndexArn,
        },
      },
    })
    // the role policy must exist before Bedrock validates access to the model and index
    knowledgeBase.node.addDependency(knowledgeBaseRole)

    const dataSource = new CfnDataSource(this, "KnowledgeBaseDataSource", {
      name: "kb-source",
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataDeletionPolicy: "DELETE",
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: {
          bucketArn: kbSourceBucket.bucketArn,
          inclusionPrefixes: ["kb-source/"],
        },
      },
      vectorIngestionConfiguration: {
        // no parsingConfiguration: BDA already parsed the files, so use the free default parser
        chunkingConfiguration: {
          chunkingStrategy: "FIXED_SIZE",
          fixedSizeChunkingConfiguration: {
            maxTokens: 300,
            overlapPercentage: 20,
          },
        },
      },
    })

    // step 4: bda project
    const bdaProject = new CfnDataAutomationProject(this, "BdaProject", {
      projectName: `${this.stackName}-documents`,
      projectType: "ASYNC",
      standardOutputConfiguration: {
        document: {
          extraction: {
            granularity: { types: ["DOCUMENT", "PAGE"] },
            boundingBox: { state: "DISABLED" },
          },
          generativeField: { state: "DISABLED" },
          outputFormat: {
            textFormat: { types: ["MARKDOWN"] },
            additionalFileFormat: { state: "DISABLED" },
          },
        },
      },
      // NO customOutputConfiguration (blueprints): custom output costs 4x per page
    })

    // the invoke call takes the home-region profile ARN; IAM also needs the other regions the profile routes to
    const bdaProfileArn = `arn:${this.partition}:bedrock:${this.region}:${this.account}:data-automation-profile/${bdaProfileId}`
    const bdaProfileAnyRegionArn = `arn:${this.partition}:bedrock:*:${this.account}:data-automation-profile/${bdaProfileId}`

    // step 5/6: pipeline lambdas, events, ingestion queue
    // only one ingestion job can run per data source, so a single FIFO message group
    // makes SQS hand the ingest lambda one batch at a time
    const ingestDlq = new Queue(this, "IngestDeadLetterQueue", {
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    })

    const ingestQueue = new Queue(this, "IngestQueue", {
      fifo: true,
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: { queue: ingestDlq, maxReceiveCount: 5 },
    })

    const commonEnvironment = {
      TABLE_NAME: databaseTable.tableName,
      RAW_BUCKET: userFileBucket.bucketName,
      BDA_OUTPUT_BUCKET: bdaOutputBucket.bucketName,
      PROCESSED_BUCKET: processedBucket.bucketName,
      KB_SOURCE_BUCKET: kbSourceBucket.bucketName,
      KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
      DATA_SOURCE_ID: dataSource.attrDataSourceId,
    }

    // bundle the AWS SDK instead of using the (older) runtime copy, which may lack BDA and S3 Vectors calls
    const pipelineFunction = (
      functionId: string,
      entry: string,
      options: { timeout: cdk.Duration; memorySize: number; environment?: Record<string, string>; retryAttempts?: number },
    ): NodejsFunction => new NodejsFunction(this, functionId, {
      entry,
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: path.join(BACKEND_ROOT, 'package-lock.json'),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      timeout: options.timeout,
      memorySize: options.memorySize,
      environment: { ...commonEnvironment, ...options.environment },
      retryAttempts: options.retryAttempts,
      bundling: { externalModules: [] },
      // CDK lambdas keep logs forever by default
      logGroup: new LogGroup(this, `${functionId}Logs`, {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    })

    const startParseFunction = pipelineFunction("StartParseFunction", path.join(JOBS_SRC, "start-parse.ts"), {
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
      environment: {
        BDA_PROJECT_ARN: bdaProject.attrProjectArn,
        BDA_PROFILE_ARN: bdaProfileArn,
      },
      // a retry must never start a second billed BDA job
      retryAttempts: 0,
    })
    databaseTable.grantReadWriteData(startParseFunction)
    userFileBucket.grantRead(startParseFunction)
    bdaOutputBucket.grantReadWrite(startParseFunction)
    startParseFunction.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["bedrock:InvokeDataAutomationAsync"],
      resources: [bdaProject.attrProjectArn, bdaProfileAnyRegionArn],
    }))

    // raw/ only, and the function never writes to this bucket
    userFileBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(startParseFunction),
      { prefix: "raw/" },
    )

    const postProcessFunction = pipelineFunction("PostProcessFunction", path.join(JOBS_SRC, "post-process.ts"), {
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        INGEST_QUEUE_URL: ingestQueue.queueUrl,
        SUMMARY_MODEL_ID: summaryModelId,
      },
    })
    databaseTable.grantReadWriteData(postProcessFunction)
    bdaOutputBucket.grantRead(postProcessFunction)
    processedBucket.grantReadWrite(postProcessFunction)
    kbSourceBucket.grantReadWrite(postProcessFunction)
    ingestQueue.grantSendMessages(postProcessFunction)
    postProcessFunction.addToRolePolicy(new PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:${this.partition}:bedrock:*::foundation-model/*`,
        `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }))

    const bdaCompletionRule = new Rule(this, "BdaCompletionRule", {
      eventPattern: {
        source: ["aws.bedrock"],
        detailType: [
          "Bedrock Data Automation Job Succeeded",
          "Bedrock Data Automation Job Failed With Client Error",
          "Bedrock Data Automation Job Failed With Service Error",
        ],
      },
    })
    bdaCompletionRule.addTarget(new LambdaFunction(postProcessFunction, {
      retryAttempts: 1,
    }))

    const ingestFunction = pipelineFunction("IngestFunction", path.join(JOBS_SRC, "ingest.ts"), {
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
    })
    databaseTable.grantReadWriteData(ingestFunction)
    ingestFunction.addEventSource(new SqsEventSource(ingestQueue, { batchSize: 10 }))
    ingestFunction.addToRolePolicy(new PolicyStatement({
      actions: ["bedrock:StartIngestionJob", "bedrock:GetIngestionJob", "bedrock:ListIngestionJobs"],
      resources: [knowledgeBase.attrKnowledgeBaseArn],
    }))

    // step 7/8: chat lambda
    const chatFunction = pipelineFunction("ChatFunction", path.join(API_SRC, "chat.ts"), {
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: { CHAT_MODEL_ID: chatModelId },
    })
    databaseTable.grantReadWriteData(chatFunction)
    processedBucket.grantRead(chatFunction)
    chatFunction.addToRolePolicy(new PolicyStatement({
      actions: ["bedrock:Retrieve"],
      resources: [knowledgeBase.attrKnowledgeBaseArn],
    }))
    chatFunction.addToRolePolicy(new PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        `arn:${this.partition}:bedrock:*::foundation-model/*`,
        `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }))

    new cdk.CfnOutput(this, "TableName", { value: databaseTable.tableName })
    new cdk.CfnOutput(this, "RawBucketName", { value: userFileBucket.bucketName })
    new cdk.CfnOutput(this, "KbSourceBucketName", { value: kbSourceBucket.bucketName })
    new cdk.CfnOutput(this, "KnowledgeBaseId", { value: knowledgeBase.attrKnowledgeBaseId })
    new cdk.CfnOutput(this, "DataSourceId", { value: dataSource.attrDataSourceId })
    new cdk.CfnOutput(this, "BdaProjectArn", { value: bdaProject.attrProjectArn })
    new cdk.CfnOutput(this, "BdaProfileArn", { value: bdaProfileArn })
  }
}
