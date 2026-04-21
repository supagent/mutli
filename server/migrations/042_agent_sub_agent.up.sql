-- Multi-agent orchestration: sub-agent relationships and event attribution.

-- Join table: an agent can have sub-agents (other agents in the same workspace).
-- When the orchestrator runs in a sandbox, sub-agent definitions are uploaded
-- as JSON and passed to ADK's sub_agents parameter.
CREATE TABLE agent_sub_agent (
    agent_id     UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    sub_agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    position     INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, sub_agent_id),
    CHECK (agent_id != sub_agent_id)
);

CREATE INDEX idx_agent_sub_agent_agent ON agent_sub_agent(agent_id);
CREATE INDEX idx_agent_sub_agent_sub ON agent_sub_agent(sub_agent_id);

-- Track which sub-agent produced each task message event.
ALTER TABLE task_message ADD COLUMN agent_name TEXT;
