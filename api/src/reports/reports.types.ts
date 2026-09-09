// One uploaded Playwright HTML report. Written as meta.json next to the
// extracted report; there is no index file — the directory listing IS the index
// (retention caps this at ~10 entries, so a scan is cheaper than keeping a
// second copy of the truth in sync).

export type ReportMeta = {
  id: string;
  /** Global server id (`<group>/<server>`) this report belongs to. Always a
   *  node that exists in config/servers — the ingest route rejects otherwise. */
  node: string;
  /** CI provenance. All optional: the report is viewable without any of it. */
  repo?: string;
  pr?: number;
  branch?: string;
  sha?: string;
  runUrl?: string;
  title?: string;
  status: 'failed' | 'passed';
  /** Size on disk of the extracted report, bytes. */
  bytes: number;
  /** ISO 8601, UTC. */
  createdAt: string;
};
