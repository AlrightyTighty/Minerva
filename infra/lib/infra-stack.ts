import * as path from 'path';
import { EndpointType, LambdaIntegration, ResponseTransferMode, RestApi } from 'aws-cdk-lib/aws-apigateway';
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
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
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
// Must be activated as a cost allocation tag in the Billing console before the budget can filter on it.
const PROJECT_TAG_KEY = 'Project';
const PROJECT_TAG_VALUE = 'Minerva';

/** How long one API request may take, for the Lambda and for the gateway in front of it. A work plan needs up to a minute or so. */
const API_TIMEOUT = cdk.Duration.minutes(2);

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

    // tag every taggable resource in the stack so the budget can filter to this project only
    cdk.Tags.of(this).add(PROJECT_TAG_KEY, PROJECT_TAG_VALUE)

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
        },
        // only count spend on resources tagged for this project (the account hosts other projects)
        filterExpression: {
          tags: {
            key: PROJECT_TAG_KEY,
            values: [PROJECT_TAG_VALUE],
            matchOptions: ["EQUALS"]
          }
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
    // only one ingestion job can run per data source. The ingest lambda never waits on a job: it re-queues
    // delayed "check" messages, and per-message delay is not supported by FIFO queues, so this is a standard queue
    const ingestDlq = new Queue(this, "IngestDeadLetterQueue", {
      retentionPeriod: cdk.Duration.days(14),
    })

    const ingestQueue = new Queue(this, "IngestQueue", {
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: { queue: ingestDlq, maxReceiveCount: 5 },
    })

    // Anthropic models are sold through AWS Marketplace, and Bedrock checks the caller's subscriptions on invoke.
    // Subscribe is deliberately left out: it would let a Lambda create Marketplace subscriptions. Marketplace
    // actions do not support resource-level permissions, so this is "*".
    const marketplaceView = new PolicyStatement({
      actions: ["aws-marketplace:ViewSubscriptions"],
      resources: ["*"],
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
    postProcessFunction.addToRolePolicy(marketplaceView)

    // when identical content was already parsed, start-parse skips BDA and hands the file to post-process directly
    startParseFunction.addEnvironment("POST_PROCESS_FUNCTION_NAME", postProcessFunction.functionName)
    postProcessFunction.grantInvoke(startParseFunction)

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
      environment: { INGEST_QUEUE_URL: ingestQueue.queueUrl },
    })
    databaseTable.grantReadWriteData(ingestFunction)
    // the window lets several uploads share one ingestion job
    ingestFunction.addEventSource(new SqsEventSource(ingestQueue, {
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(30),
    }))
    // re-queues its own delayed "check" and "start" messages
    ingestQueue.grantSendMessages(ingestFunction)
    ingestFunction.addToRolePolicy(new PolicyStatement({
      actions: ["bedrock:StartIngestionJob", "bedrock:GetIngestionJob", "bedrock:ListIngestionJobs"],
      resources: [knowledgeBase.attrKnowledgeBaseArn],
    }))

    // the JWT signing key. It is passed to `cdk deploy --parameters`, held by CloudFormation as a masked (NoEcho)
    // parameter with no default, kept in a Secrets Manager secret, and read by the API Lambda when it starts.
    // It is not in the template, an environment variable, an output or any policy, so only the secret itself holds it.
    const jwtPrivateKey = new cdk.CfnParameter(this, "JwtPrivateKey", {
      type: "String",
      noEcho: true,
      description: "The JWT signing key, as one line of base64 (see the deploy notes). Required on every deploy that creates or changes it.",
    })
    const jwtKeySecret = new Secret(this, "JwtKeySecret", {
      description: "Signs the API's access tokens",
      secretStringValue: cdk.SecretValue.cfnParameter(jwtPrivateKey),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // api: the Fastify app as one Lambda behind an HTTP API, which also serves chat
    // it reads the table, bucket and knowledge base names from the environment, so nothing in the app hard-codes them
    const apiFunction = pipelineFunction("ApiFunction", path.join(API_SRC, "lambda.ts"), {
      // a streamed reply can run well past the 29 seconds a buffered API Gateway response allows
      timeout: API_TIMEOUT,
      memorySize: 512,
      // course matching is a small structured task, so it uses the cheap model that post-process summarises with
      environment: {
        APP_ENV: "production",
        CHAT_MODEL_ID: chatModelId,
        MATCH_MODEL_ID: summaryModelId,
        // planning needs real reasoning, so it uses the chat model and not the cheap one
        WORK_PLAN_MODEL_ID: chatModelId,
        // where the signing key is kept, never the key itself
        JWT_KEY_SECRET_ARN: jwtKeySecret.secretArn,
      },
    })
    // the only reader of the key. It can read that one secret and cannot change it.
    jwtKeySecret.grantRead(apiFunction)
    databaseTable.grantReadWriteData(apiFunction)
    // the API signs upload URLs, so its role must be allowed to put to the raw bucket. It never puts objects itself.
    userFileBucket.grantPut(apiFunction)
    // chat reads uploaded images from the raw bucket and a file's Markdown from the processed bucket
    userFileBucket.grantRead(apiFunction)
    processedBucket.grantRead(apiFunction)
    apiFunction.addToRolePolicy(new PolicyStatement({
      actions: ["bedrock:Retrieve"],
      resources: [knowledgeBase.attrKnowledgeBaseArn],
    }))
    apiFunction.addToRolePolicy(new PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        `arn:${this.partition}:bedrock:*::foundation-model/*`,
        `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }))
    apiFunction.addToRolePolicy(marketplaceView)

    // a REST API, because an HTTP API buffers responses and so cannot stream chat replies.
    // regional, because an edge-optimized endpoint cuts a stream off after 30 seconds without data
    const restApi = new RestApi(this, "RestApi", {
      endpointTypes: [EndpointType.REGIONAL],
      // every path, the root included, goes to the app, which does its own routing and authentication
      // the gateway has its own integration timeout, separate from the Lambda's, which is 29 seconds unless it is
      // set here, so it is set to the same value as the Lambda's
      defaultIntegration: new LambdaIntegration(apiFunction, {
        responseTransferMode: ResponseTransferMode.STREAM,
        timeout: API_TIMEOUT,
      }),
      deployOptions: {
        // the API is public, so cap the request rate to keep a flood from becoming a bill
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
      },
    })
    restApi.root.addMethod("ANY")
    restApi.root.addProxy({ anyMethod: true })

    new cdk.CfnOutput(this, "ApiUrl", { value: restApi.url })
    new cdk.CfnOutput(this, "TableName",{ value: databaseTable.tableName })
    new cdk.CfnOutput(this, "RawBucketName", { value: userFileBucket.bucketName })
    new cdk.CfnOutput(this, "BdaOutputBucketName", { value: bdaOutputBucket.bucketName })
    new cdk.CfnOutput(this, "KbSourceBucketName",{ value: kbSourceBucket.bucketName })
    new cdk.CfnOutput(this, "KnowledgeBaseId", { value: knowledgeBase.attrKnowledgeBaseId })
    new cdk.CfnOutput(this, "DataSourceId", { value: dataSource.attrDataSourceId })
    new cdk.CfnOutput(this, "BdaProjectArn", { value: bdaProject.attrProjectArn })
    new cdk.CfnOutput(this, "BdaProfileArn", { value: bdaProfileArn })
  }
}
