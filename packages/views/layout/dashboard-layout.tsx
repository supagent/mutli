"use client";

import type { ReactNode } from "react";
import { SidebarProvider, SidebarInset } from "@multica/ui/components/ui/sidebar";
import { WorkspaceIdProvider } from "@multica/core/hooks";
import { ModalRegistry } from "../modals/registry";
import { AppSidebar } from "./app-sidebar";
import { useDashboardGuard } from "./use-dashboard-guard";

interface DashboardLayoutProps {
  children: ReactNode;
  /** Sibling of SidebarInset (e.g. SearchCommand, ChatWindow) */
  extra?: ReactNode;
  /** Rendered inside sidebar header as a search trigger */
  searchSlot?: ReactNode;
  /** Loading indicator */
  loadingIndicator?: ReactNode;
}

export function DashboardLayout({
  children,
  extra,
  searchSlot,
  loadingIndicator,
}: DashboardLayoutProps) {
  const { user, isLoading, workspace } = useDashboardGuard("/");

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        {loadingIndicator}
      </div>
    );
  }

  if (!user) return null;

  if (!workspace) {
    return (
      <div className="flex h-svh items-center justify-center">
        {loadingIndicator}
      </div>
    );
  }

  return (
    <WorkspaceIdProvider wsId={workspace.id}>
      <SidebarProvider className="h-svh">
        <AppSidebar searchSlot={searchSlot} />
        <SidebarInset className="overflow-hidden">
          {children}
          <ModalRegistry />
        </SidebarInset>
        {extra}
      </SidebarProvider>
    </WorkspaceIdProvider>
  );
}
