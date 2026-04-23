-- Parent-child task relationships for multi-agent orchestration.
-- An orchestrator task can spawn child tasks that run concurrently
-- on potentially different runtimes.

ALTER TABLE agent_task_queue
    ADD COLUMN parent_task_id UUID REFERENCES agent_task_queue(id) ON DELETE SET NULL,
    ADD COLUMN role TEXT CHECK (role IN ('orchestrator', 'worker', 'synthesizer'));

CREATE INDEX idx_task_parent ON agent_task_queue(parent_task_id)
    WHERE parent_task_id IS NOT NULL;

-- Add 'waiting' to status constraint (parent waits for children).
ALTER TABLE agent_task_queue DROP CONSTRAINT agent_task_queue_status_check;
ALTER TABLE agent_task_queue ADD CONSTRAINT agent_task_queue_status_check
    CHECK (status IN ('queued', 'dispatched', 'running', 'waiting', 'completed', 'failed', 'cancelled'));
