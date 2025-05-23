import { mkdir, writeFile } from "fs/promises";
import { join }           from "path";
import { DEEBO_ROOT }     from "../index.js";
import { getProjectId }   from "./sanitize.js";

export async function writeReport(
  repoPath: string,
  sessionId: string,
  scenarioId: string,
  report: any
) {
  const projectId = getProjectId(repoPath);
  const reportDir = join(
    DEEBO_ROOT,
    "memory-bank",
    projectId,
    "sessions",
    sessionId,
    "reports"
  );
  await mkdir(reportDir, { recursive: true });

  // pretty-print with 2-space indent
  const reportPath = join(reportDir, `${scenarioId}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
}