DROP INDEX IF EXISTS idx_agent_task_queue_retried_from;
CREATE INDEX idx_agent_task_queue_retried_from ON agent_task_queue(retried_from_id) WHERE retried_from_id IS NOT NULL;
