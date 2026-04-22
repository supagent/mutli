-- Revert status constraint to original values.
ALTER TABLE agent_task_queue DROP CONSTRAINT agent_task_queue_status_check;
ALTER TABLE agent_task_queue ADD CONSTRAINT agent_task_queue_status_check
    CHECK (status IN ('queued', 'dispatched', 'running', 'completed', 'failed', 'cancelled'));

DROP INDEX IF EXISTS idx_task_parent;
ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS role;
ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS parent_task_id;
