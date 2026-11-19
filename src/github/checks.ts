export interface WorkflowRun {
  owner: string;
  repo: string;
  runId: number;
}

// A note on a run, in the listener's log: the App posts no check runs
// (owner, 2026-11-19). Its name names the run.
export interface Note {
  name: string;
  title: string;
  summary: string;
}
