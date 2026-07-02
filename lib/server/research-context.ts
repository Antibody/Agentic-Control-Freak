import { readArtifactFile } from "@/lib/server/artifacts";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { renderUntrustedSource } from "@/lib/server/source-context";
import { boundedText } from "@/lib/server/text-bounds";
import type { Identifier } from "@/lib/shared/types";

export interface ResearchContext {
  artifactId: Identifier;
  artifactUri: string;
  request: string;
  summary: string;
  reportExcerpt: string;
}

const maxSummaryChars = 5000;
const maxReportChars = 12000;

export function requestReferencesPriorResearch(userRequest: string): boolean {
  const normalized = userRequest.toLowerCase().replace(/\s+/g, " ");
  return (
    /\b(researched|research report|report|analysis|studied|investigated)\b/.test(normalized) ||
    /\b(the|that|this)\s+(app|repo|project|codebase|one)\b/.test(normalized) ||
    /\b(just like|based on|same as|similar to|recreate|clone|simplified version)\b/.test(normalized)
  );
}

function newestFirst<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function compactText(value: string, maxChars: number): string {
  return boundedText(value.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim(), maxChars);
}

export async function findLatestResearchContext(input: {
  workSessionId: Identifier;
  userRequest: string;
}): Promise<ResearchContext | null> {
  if (!requestReferencesPriorResearch(input.userRequest)) {
    return null;
  }

  const db = await getDatabaseSnapshot();
  const researchArtifact = newestFirst(
    db.artifacts.filter((artifact) =>
      artifact.workSessionId === input.workSessionId &&
      artifact.artifactKind === "report" &&
      (
        artifact.metadata.artifactRole === "research_full_report" ||
        artifact.metadata.artifactRole === "research_report"
      )
    )
  )[0] ?? null;

  if (researchArtifact === null) {
    return null;
  }

  const report = await readArtifactFile(researchArtifact).catch(() => "");
  const workSession = db.workSessions.find((candidate) => candidate.id === input.workSessionId) ?? null;
  const chatSummary = newestFirst(
    db.chatMessages.filter((message) =>
      workSession !== null &&
      message.chatSessionId === workSession.chatSessionId &&
      message.role === "assistant" &&
      message.messageKind === "research_report"
    )
  )[0]?.content ?? "";

  const request = typeof researchArtifact.metadata.request === "string"
    ? researchArtifact.metadata.request
    : "";

  return {
    artifactId: researchArtifact.id,
    artifactUri: researchArtifact.storageUri,
    request,
    summary: compactText(chatSummary, maxSummaryChars),
    reportExcerpt: compactText(report, maxReportChars),
  };
}

export function renderResearchContextForPrompt(context: ResearchContext | null): string {
  if (context === null) {
    return "";
  }
  return renderUntrustedSource({
    sourceType: "research",
    sourceId: context.artifactId,
    title: "Relevant prior research context",
    content: `Relevant prior research context:
- Research artifact id: ${context.artifactId}
- Research artifact path: ${context.artifactUri}
- Original research request: ${context.request || "(not recorded)"}

Chat summary:
${context.summary || "(no chat summary recorded)"}

Full research report excerpt:
${context.reportExcerpt || "(unable to read research report)"}
`,
    maxChars: maxSummaryChars + maxReportChars + 2000,
  });
}
