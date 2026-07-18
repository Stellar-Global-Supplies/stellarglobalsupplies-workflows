-- Ensure approval_queue can be linked back to workflow_runs in all environments.
ALTER TABLE IF EXISTS approval_queue
  ADD COLUMN IF NOT EXISTS workflow_run_id UUID;

CREATE INDEX IF NOT EXISTS idx_approval_queue_workflow_run_id
  ON approval_queue(workflow_run_id);
