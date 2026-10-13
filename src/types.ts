export interface Repository {
  path: string;
  name: string;
  gitDir: string;
  commonDir: string;
  kind: 'repository' | 'worktree';
  branch: string | null;
  remotes: { name: string; url: string }[];
}

export interface Package {
  name: string;
  path: string;
  manifestPath: string;
  repositoryPath: string | null;
  version: string | null;
  private: boolean;
  workspaces: string[];
}

export interface ScanIssue {
  path: string;
  code: string;
  message: string;
  /** Preserve previous records beneath this path when it could not be read. */
  preserve: boolean;
}

export interface Snapshot {
  scannedAt: string | null;
  repositories: Repository[];
  packages: Package[];
  issues: ScanIssue[];
  visitedDirectories: number;
}

export interface Mapping {
  name: string;
  path: string;
  note: string;
  updatedAt: string;
}

export interface State {
  schemaVersion: 1;
  revision: number;
  config: { roots: string[]; excludes: string[]; maxDepth: number };
  snapshot: Snapshot;
  mappings: Mapping[];
  history: { at: string; action: string; details: unknown }[];
}

export class ResolverError extends Error {
  constructor(public code: string, message: string, public details?: unknown, public exitCode = 1) {
    super(message);
  }
}
