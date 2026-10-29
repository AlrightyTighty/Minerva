import { RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import type { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";

export interface SearchFilter {
  userId: string;
  courseId: string;
  /** Narrows the search to one file. */
  fileId?: string;
  docType?: string;
}

export interface SearchHit {
  text: string;
  score: number;
  fileId?: string;
  docType?: string;
}

export interface CourseSearch {
  retrieve(input: { query: string; filter: SearchFilter; topK: number }): Promise<SearchHit[]>;
}

export class BedrockCourseSearch implements CourseSearch {
  constructor(
    private readonly client: BedrockAgentRuntimeClient,
    private readonly knowledgeBaseId: string,
  ) {}

  async retrieve(input: { query: string; filter: SearchFilter; topK: number }): Promise<SearchHit[]> {
    const { userId, courseId, fileId, docType } = input.filter;

    // the user and course filters are always present, so no caller can search outside its own course;
    // soft-deleted files are hidden here too, through the "deleted" attribute in each sidecar
    const conditions = [
      { equals: { key: "user_id", value: userId } },
      { equals: { key: "course_id", value: courseId } },
      { equals: { key: "deleted", value: false } },
      ...(fileId ? [{ equals: { key: "file_id", value: fileId } }] : []),
      ...(docType ? [{ equals: { key: "doc_type", value: docType } }] : []),
    ];

    const response = await this.client.send(
      new RetrieveCommand({
        knowledgeBaseId: this.knowledgeBaseId,
        retrievalQuery: { text: input.query },
        retrievalConfiguration: {
          vectorSearchConfiguration: { numberOfResults: input.topK, filter: { andAll: conditions } },
        },
      }),
    );

    return (response.retrievalResults ?? []).flatMap((result) => {
      const text = result.content?.text;
      if (!text) {
        return [];
      }
      const metadata = result.metadata as Record<string, unknown> | undefined;
      return [
        {
          text,
          score: result.score ?? 0,
          ...(typeof metadata?.file_id === "string" ? { fileId: metadata.file_id } : {}),
          ...(typeof metadata?.doc_type === "string" ? { docType: metadata.doc_type } : {}),
        },
      ];
    });
  }
}
