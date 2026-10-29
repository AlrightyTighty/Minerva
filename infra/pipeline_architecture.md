# Study App — Bedrock Pipeline Reference

A reference for the course-materials pipeline: upload → BDA → Knowledge Base (S3 Vectors) → chat with tools, plus the DynamoDB data model and the billing traps to avoid.

---

## 1. Architecture at a glance

```
Student upload
   │
   ▼
S3  raw/{userId}/{courseId}/{fileId}/original.pdf
   │  (S3 event → Lambda: start-parse)
   ▼
BDA async job (InvokeDataAutomationAsync, standard output, Markdown)
   │  (EventBridge completion → Lambda: post-process)
   ▼
S3  processed/.../full.md                  ← used for hydration / get_resource
S3  kb-source/.../part-NN.md + .metadata.json   ← KB data source
   │  (StartIngestionJob or direct ingestion)
   ▼
Bedrock Knowledge Base  →  S3 Vectors index
   │
   ▼
Chat Lambda: Converse/ConverseStream + tools (search, get/load resource)
   │
   ▼
DynamoDB (single table): files, threads, messages
```

**Core idea:** DynamoDB is the catalog, S3 holds content, the KB is search over the large docs. A shared `file_id` (in the S3 path and the KB metadata sidecar) ties them together.

---

## 2. Key limits to remember

| Thing | Limit |
|---|---|
| KB source file size | 50 MB per file (applies to what you put in `kb-source/`, i.e. the Markdown, which is tiny) |
| BDA async document | up to 500 MB, up to 3,000 pages with splitter |
| BDA sync document | 10 pages / 50 MB. **Use async.** |
| DynamoDB item | 400 KB. **Never store file content or retrieved chunks in items.** |
| Ingestion jobs | One running job per data source at a time. Queue or batch syncs. |

---

## 3. S3 layout (IDs encoded in every path)

```
raw/{userId}/{courseId}/{fileId}/original.pdf
bda-output/{userId}/{courseId}/{fileId}/...
processed/{userId}/{courseId}/{fileId}/full.md
kb-source/{userId}/{courseId}/{fileId}/part-01.md
kb-source/{userId}/{courseId}/{fileId}/part-01.md.metadata.json
```

- Every Lambda can parse `userId / courseId / fileId` from the key it receives, so there's no GSI or lookup needed to find the DynamoDB item.
- **Use separate buckets (or strictly separate prefixes with filtered event notifications) for raw, BDA output, and KB source.** See the recursive-trigger gotcha below.

### Metadata sidecar

The sidecar must be named exactly `<source filename>.metadata.json` and sit in the same folder as the source file. If the name is wrong, the metadata is silently ignored and filters return nothing.

```json
{
  "metadataAttributes": {
    "file_id": "f42",
    "user_id": "s1",
    "course_id": "cs101",
    "doc_type": "textbook",
    "chapter": 4
  }
}
```

`file_id` in the metadata lets every retrieved chunk map back to its DynamoDB item, which you need for citations and filtering.

---

## 4. Ingestion pipeline steps

1. **Upload.** The client gets a presigned URL and uploads to `raw/...`. Create the file item with `status: "uploaded"`.
2. **start-parse Lambda** (S3 event on `raw/` only):
   - Compute `content_hash`. If an identical file was already processed, reuse its output (dedupe) and skip BDA.
   - Small or simple files (short text docs, images) can skip BDA.
   - Otherwise call `InvokeDataAutomationAsync`, store `bda_invocation_arn`, and set `status: "parsing"`.
   - Make this idempotent: if output already exists for this hash or file, don't start another job.
3. **post-process Lambda** (EventBridge BDA completion):
   - Read the BDA Markdown output and write `processed/.../full.md`.
   - Split by chapter or section (not by bytes) only if needed. Write the `kb-source/` parts and their sidecars.
   - Compute `token_count` (chars ÷ 4 is fine). Generate a 1–2 sentence `summary` with a cheap model. Set `search_only` for textbooks and large files.
   - Set `status: "ingesting"` and trigger ingestion.
4. **Ingestion:** `StartIngestionJob` (queue it, since only one job can run per data source) or the direct document ingestion API. On completion, set `status: "ready"`.
5. **Delete:** remove the `kb-source/` objects for the file, then re-sync (or use the direct-ingestion delete). Otherwise the deleted file stays searchable.

---

## 5. CDK resources (all Bedrock / S3 Vectors pieces are L1)

| Resource | Construct | Notes |
|---|---|---|
| Buckets, Lambdas, EventBridge rules, DynamoDB | L2 | `RemovalPolicy.DESTROY`, `autoDeleteObjects` for dev |
| Vector bucket | `s3vectors.CfnVectorBucket` | Default SSE-S3 encryption is free. **Don't use a KMS CMK.** |
| Vector index | `s3vectors.CfnIndex` | See config below |
| Knowledge Base | `bedrock.CfnKnowledgeBase` | Storage = S3 Vectors. No vector store is auto-created. |
| Data source | `bedrock.CfnDataSource` | See config below |
| BDA project | `bedrock.CfnDataAutomationProject` | See config below |
| Budget alert | `budgets.CfnBudget` | Email alert at ~$15–20 |

- Don't use the third-party `cdk-s3-vectors` package. Native constructs exist now.
- Bundle a current AWS SDK in your Lambdas if BDA runtime or S3 Vectors calls fail with "unknown operation."

### Vector index

```ts
new s3vectors.CfnIndex(this, 'Index', {
  vectorBucketName: vectorBucket.ref,
  dataType: 'float32',
  dimension: 1024,              // must match the embedding model (Titan Text Embeddings V2 = 1024)
  distanceMetric: 'cosine',
  metadataConfiguration: {
    // Bedrock stores chunk text here, and it would exceed the filterable metadata limit
    nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
  },
});
```

### Data source

- **Omit the parsing configuration**, so the KB uses the free default parser. You already ran BDA, so setting `BEDROCK_DATA_AUTOMATION` here would pay twice for every page.
- Set chunking explicitly (the default is fixed 300 tokens with 20% overlap) so results don't change if defaults change.
- Set `dataDeletionPolicy: 'DELETE'` explicitly.

### BDA project

```ts
standardOutputConfiguration: {
  document: {
    extraction: {
      granularity: { types: ['DOCUMENT', 'PAGE'] },
      boundingBox: { state: 'DISABLED' },
    },
    generativeField: { state: 'DISABLED' },
    outputFormat: {
      textFormat: { types: ['MARKDOWN'] },
      additionalFileFormat: { state: 'DISABLED' },
    },
  },
},
projectType: 'ASYNC',
// NO customOutputConfiguration (blueprints): custom output costs 4x per page
```

---

## 6. DynamoDB data model (single table)

| Item | PK | SK |
|---|---|---|
| File | `STUDENT#<userId>` | `COURSE#<courseId>#FILE#<fileId>` |
| Thread | `STUDENT#<userId>` | `COURSE#<courseId>#THREAD#<threadId>` |
| Message | `THREAD#<threadId>` | `MSG#<ulid>` |

### File

```ts
{
  file_id, user_id, course_id,
  original_filename, title,
  doc_type: "assignment" | "syllabus" | "textbook" | "notes" | "image",
  summary,                     // filled after processing; drives model relevance decisions
  raw_key, mime_type, size_bytes, content_hash,
  markdown_key,                // read by hydration / get_resource
  kb_prefix,                   // for deletion / re-ingest
  status: "uploaded" | "parsing" | "ingesting" | "ready" | "failed",
  error?, bda_invocation_arn?, page_count?,
  token_count?, search_only,
  created_at, updated_at
}
```

### Thread

```ts
{
  thread_id, user_id, course_id,   // check user_id on every request
  title,
  mode: "assignment_help" | "exam_prep" | "concept_review",
  turn_count,
  focus_resource_ids: string[],    // pinned: always hydrate if small
  active_resources: { [fileId]: { loaded_at_turn, expires_after_turn } },
  summary?, summary_through?,      // only if you add summarization later
  created_at, updated_at
}
```

Update `active_resources` and `turn_count` with an `UpdateExpression` (`SET active_resources.#f = :v ADD turn_count :one`), not a full item overwrite, so two quick messages don't overwrite each other's changes.

### Message

```ts
{
  message_id,                      // ULID
  role: "user" | "assistant",
  turn,
  content: ContentBlock[],
  hydrated_resource_ids: string[], // debug: what was in context
  ttl?
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_ref"; resource_id: string }                 // attachment
  | { type: "tool_call"; tool_use_id: string; name: string; input: object }
  | { type: "tool_result_ref"; tool_use_id: string; resource_id?: string; summary: string };
```

**Store references, never content.** Retrieved chunks only matter within the request that fetched them. Persist a one-line placeholder.

### Access patterns

| Need | Query |
|---|---|
| Course catalog | `PK=STUDENT#s1, begins_with(SK, "COURSE#cs101#FILE#")` |
| Threads for a course | `PK=STUDENT#s1, begins_with(SK, "COURSE#cs101#THREAD#")` |
| Recent messages | `PK=THREAD#t7, ScanIndexForward=false, Limit=N` (then reverse) |

---

## 7. Chat flow (per turn)

1. **Load in parallel:** the thread item (and ownership check), the course catalog (only `status: "ready"` files), and the recent messages.
2. **Hydrate deterministically** within a token budget (~20k):
   1. attachments in the current message (always)
   2. `focus_resource_ids` (if small)
   3. unexpired `active_resources`
   4. everything else is a placeholder, e.g. `[f58: "Lab 2 handout" (use get_resource)]`
   - Never auto-hydrate `search_only` files (textbooks).
   - Images are hydrated only in the turn they're attached, unless pinned.
3. **Build the prompt:** system prompt (by `mode`), then the catalog (title, type, summary per file), then the hydrated files (stable order, so prompt caching works), then the message history (tool results pruned).
4. **Write the user message**, then call `ConverseStream`.
5. **Handle tool calls** (stream a status like "Reading Assignment 3…" to the UI).
6. **Write the assistant message** and increment `turn_count`.

### Tools

| Tool | Purpose |
|---|---|
| `search_course_materials(query, resource_id?, doc_type?)` | Runs `Retrieve` on the KB. **Always AND in `user_id` and `course_id` from the session server-side.** The model can narrow the search, never widen it. |
| `get_resource(resource_id)` | Returns the full Markdown of a small file. Refuses `search_only` files. |
| `load_resource(resource_id)` | Like `get_resource`, but adds the file to `active_resources` for k turns. Extend the expiry if it's used again. Cap the active set and evict the soonest-expiring. Refuses `search_only`. |

Use `Retrieve` + `Converse` rather than `RetrieveAndGenerate`, for control over prompts, filters, and tools.

### Conversation design decisions

- **The course is the scope for permissions and retrieval. Each task is its own thread.** Make "New chat" a first-class button. This prevents most context rot.
- **No summarization to start.** Send the full pruned history. Add a hard truncation limit (~40k tokens of history). Add async, threshold-triggered summarization only if truncation actually causes problems.
- **The model is stateless.** Every turn rebuilds context from DynamoDB and S3, so closing and reopening a chat needs no special handling. The only difference is a cold prompt cache on the first turn back.

### Latency

- File reads (S3, DynamoDB) take milliseconds. **Model round-trips are the cost.** Each tool call adds another full model call.
- Stream responses (`ConverseStream`, plus Lambda response streaming or WebSockets). This makes the biggest difference to how fast the app feels.
- Pre-hydrate predictable files so `load_resource` is the exception.
- Use prompt caching: put pinned and active files right after the system prompt in a stable order.
- Keep a module-level cache in warm Lambdas for Markdown and catalogs.
- Watch the ~29s API Gateway REST default timeout. Streaming or WebSockets avoid it.

---

## 8. Billing gotchas ⚠️

1. **OpenSearch Serverless default.** The console's KB quick-create defaults to it, and it costs roughly $350/month even when idle. **Always use S3 Vectors.** In CDK you must specify the store explicitly, which is safer.
2. **Recursive S3 triggers.** This is the biggest risk. If a Lambda writes output into the bucket or prefix that triggers it, every loop starts another BDA job billed per page. Separate buckets or prefixes, and filtered notifications.
3. **Retries that start duplicate BDA jobs.** Async Lambda invocations and EventBridge retry by default. Make start-parse idempotent (check hash or output before invoking) and consider lowering `retryAttempts`.
4. **Double parsing.** Don't set BDA or a foundation model as the KB parser when you already pre-parse with BDA. The KB parser applies to every PDF in the data source.
5. **BDA custom output.** Blueprints cost $0.04 per page vs $0.01 for standard. Never configure `customOutputConfiguration`.
6. **Developing against full textbooks.** Use a 20–30 page excerpt while building the pipeline. Process the full books once, and keep the Markdown in S3 so you never re-parse.
7. **Duplicate uploads.** Dedupe by `content_hash` so the same textbook is never parsed twice.
8. **KMS customer-managed keys.** About $1/month each plus request charges. The default SSE-S3 encryption is free.
9. **CloudWatch log retention.** CDK Lambdas keep logs forever by default. Set 1–2 week retention.
10. **Forgetting teardown.** `cdk destroy` at the end of the semester. If it hangs on KB, data source, or index ordering, delete the KB in the console and rerun.
11. **Budget alert.** Set one at ~$15–20 before uploading anything big.

### Expected cost (demo scale)

| Item | Estimate |
|---|---|
| BDA (~1,500 pages at $0.01/page) | ~$15 |
| Embeddings | a few cents |
| S3 Vectors (storage, PUTs, queries) | well under $1 |
| S3 / DynamoDB / Lambda | ~free tier |
| Model calls (build + demo) | a few dollars |
| **Total** | **~$15–20** (target < $30) |

BDA is the biggest line item. Parsing half a textbook or a smaller book is the most effective way to cut cost.

---

## 9. Suggested build order

1. [x] CDK: buckets, DynamoDB table
2. [x] CDK: S3 Vectors bucket and index, KB, data source (default parser, explicit chunking, `DELETE` policy)
3. [x] Manually drop one `.md` and its sidecar into `kb-source/`, sync, and test `Retrieve` with a metadata filter
4. [x] CDK: BDA project. Test on a 20-page excerpt from the CLI or a script
5. [x] start-parse Lambda (idempotent, dedupe by hash) and post-process Lambda (split, sidecars, summary, token count)
6. [x] Ingestion trigger and status updates; delete flow
7. [x] Chat Lambda: thread and catalog loading, deterministic hydration, `ConverseStream`
8. [x] Tools: `search_course_materials`, then `get_resource`, then `load_resource`
9. [x] Frontend: streaming, tool status messages, "New chat", file status indicators
10. [x] Process the real demo textbooks (once!)
11. [] After the semester: `cdk destroy`, confirm the bill is $0 the following month