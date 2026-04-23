"use client";

import { useState } from "react";
import { Plus, Bot, Trash2 } from "lucide-react";
import type { Agent } from "@multica/core/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { toast } from "sonner";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions, workspaceKeys } from "@multica/core/workspace/queries";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export function SubAgentsTab({
  agent,
}: {
  agent: Agent;
}) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  const { data: workspaceAgents = [] } = useQuery(agentListOptions(wsId));
  const [saving, setSaving] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const subAgentIds = new Set(agent.sub_agents.map((sa) => sa.id));
  // Exclude self and already-added agents from picker.
  const availableAgents = workspaceAgents.filter(
    (a) => a.id !== agent.id && !subAgentIds.has(a.id) && !a.archived_at,
  );

  const handleAdd = async (subAgentId: string) => {
    setSaving(true);
    try {
      const newIds = [...agent.sub_agents.map((sa) => sa.id), subAgentId];
      await api.setSubAgents(agent.id, { sub_agent_ids: newIds });
      qc.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) });
      setShowPicker(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add sub-agent");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (subAgentId: string) => {
    setSaving(true);
    try {
      const newIds = agent.sub_agents.filter((sa) => sa.id !== subAgentId).map((sa) => sa.id);
      await api.setSubAgents(agent.id, { sub_agent_ids: newIds });
      qc.invalidateQueries({ queryKey: workspaceKeys.agents(wsId) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove sub-agent");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Sub-Agents</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Sub-agents this orchestrator can delegate work to during task execution.
          </p>
        </div>
        <Button
          variant="outline"
          size="xs"
          onClick={() => setShowPicker(true)}
          disabled={saving || availableAgents.length === 0}
        >
          <Plus className="h-3 w-3" />
          Add Sub-Agent
        </Button>
      </div>

      {agent.sub_agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
          <Bot className="h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm text-muted-foreground">No sub-agents configured</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add sub-agents to enable multi-agent orchestration.
          </p>
          {availableAgents.length > 0 && (
            <Button
              onClick={() => setShowPicker(true)}
              size="xs"
              className="mt-3"
              disabled={saving}
            >
              <Plus className="h-3 w-3" />
              Add Sub-Agent
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {agent.sub_agents.map((subAgent) => (
            <div
              key={subAgent.id}
              className="flex items-center gap-3 rounded-lg border px-4 py-3"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Bot className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{subAgent.name}</div>
                {subAgent.description && (
                  <div className="text-xs text-muted-foreground truncate">
                    {subAgent.description}
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => handleRemove(subAgent.id)}
                disabled={saving}
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${subAgent.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Sub-Agent Picker Dialog */}
      {showPicker && (
        <Dialog open onOpenChange={(v) => { if (!v) setShowPicker(false); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-sm">Add Sub-Agent</DialogTitle>
              <DialogDescription className="text-xs">
                Select an agent to add as a sub-agent for orchestration.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {availableAgents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => handleAdd(a.id)}
                  disabled={saving}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50"
                >
                  <Bot className="h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{a.name}</div>
                    {a.description && (
                      <div className="text-xs text-muted-foreground truncate">
                        {a.description}
                      </div>
                    )}
                  </div>
                </button>
              ))}
              {availableAgents.length === 0 && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No other agents available to add.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowPicker(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
