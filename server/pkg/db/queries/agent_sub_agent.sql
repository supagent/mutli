-- Agent sub-agent junction (orchestrator → sub-agents)

-- name: ListSubAgents :many
SELECT a.id, a.name, a.description, a.instructions
FROM agent a
JOIN agent_sub_agent asa ON asa.sub_agent_id = a.id
WHERE asa.agent_id = $1
ORDER BY asa.position ASC;

-- name: AddSubAgent :exec
INSERT INTO agent_sub_agent (agent_id, sub_agent_id, position)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: RemoveAllSubAgents :exec
DELETE FROM agent_sub_agent WHERE agent_id = $1;

-- name: CountSubAgents :one
SELECT count(*) FROM agent_sub_agent WHERE agent_id = $1;

-- name: ListSubAgentsByWorkspace :many
SELECT asa.agent_id, a.id AS sub_agent_id, a.name, a.description
FROM agent_sub_agent asa
JOIN agent a ON a.id = asa.sub_agent_id
WHERE a.workspace_id = $1
ORDER BY asa.agent_id, asa.position ASC;
