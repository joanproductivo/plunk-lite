-- Plunk Lite: workflows that keep their contacts until an Exit step. Tables of their own, with no
-- foreign key to "workflows" or "workflow_executions", so that Plunk's own tables stay exactly as
-- upstream has them and going back to the official image only leaves these tables unused (the
-- contacts waiting at the end of a workflow then stay finished).
-- CreateTable
CREATE TABLE "plunk_lite_workflow_settings" (
    "workflowId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "keepUntilExit" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plunk_lite_workflow_settings_pkey" PRIMARY KEY ("workflowId")
);

-- CreateTable
CREATE TABLE "plunk_lite_parked_runs" (
    "executionId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "branch" TEXT,
    "parkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plunk_lite_parked_runs_pkey" PRIMARY KEY ("executionId")
);

-- CreateIndex
CREATE INDEX "plunk_lite_workflow_settings_projectId_idx" ON "plunk_lite_workflow_settings"("projectId");

-- CreateIndex
CREATE INDEX "plunk_lite_parked_runs_workflowId_stepId_idx" ON "plunk_lite_parked_runs"("workflowId", "stepId");

-- CreateIndex
CREATE INDEX "plunk_lite_parked_runs_workflowId_contactId_idx" ON "plunk_lite_parked_runs"("workflowId", "contactId");

-- CreateIndex
CREATE INDEX "plunk_lite_parked_runs_projectId_idx" ON "plunk_lite_parked_runs"("projectId");
