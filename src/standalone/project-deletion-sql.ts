/** Fixed child-first whole-row statements. No inferred/recursive deletion at runtime. */
export const projectDeletionStatements = [
  {
    table: "assignment_conversations",
    where: "assignmentId IN (SELECT value FROM json_each(:assignments))",
    sql: "DELETE FROM assignment_conversations WHERE assignmentId IN (SELECT value FROM json_each(:assignments))",
  },
  {
    table: "command_receipts",
    where: "scope = :projectId",
    sql: "DELETE FROM command_receipts WHERE scope = :projectId",
  },
  {
    table: "conversation_archives",
    where: "threadId IN (SELECT value FROM json_each(:threads))",
    sql: "DELETE FROM conversation_archives WHERE threadId IN (SELECT value FROM json_each(:threads))",
  },
  {
    table: "conversation_history_items",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM conversation_history_items WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "conversation_history_turn_omissions",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM conversation_history_turn_omissions WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "coordination_completion_requests",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_completion_requests WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_delegations",
    where: "assignmentId IN (SELECT value FROM json_each(:assignments))",
    sql: "DELETE FROM coordination_delegations WHERE assignmentId IN (SELECT value FROM json_each(:assignments))",
  },
  {
    table: "coordination_delivery_events",
    where:
      "eventId IN (SELECT value FROM json_each(:events)) OR batchId IN (SELECT value FROM json_each(:batches))",
    sql: "DELETE FROM coordination_delivery_events WHERE eventId IN (SELECT value FROM json_each(:events)) OR batchId IN (SELECT value FROM json_each(:batches))",
  },
  {
    table: "coordination_external_delivery_notices",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_external_delivery_notices WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_local_review_draft_operations",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_local_review_draft_operations WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_local_review_drafts",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_local_review_drafts WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_local_review_groups",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_local_review_groups WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_local_review_losses",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_local_review_losses WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_local_review_stage_operations",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_local_review_stage_operations WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_local_review_submissions",
    where:
      "reviewId IN (SELECT value FROM json_each(:reviews)) OR groupId IN (SELECT value FROM json_each(:reviewGroups)) OR submittedContextId IN (SELECT value FROM json_each(:submittedContexts))",
    sql: "DELETE FROM coordination_local_review_submissions WHERE reviewId IN (SELECT value FROM json_each(:reviews)) OR groupId IN (SELECT value FROM json_each(:reviewGroups)) OR submittedContextId IN (SELECT value FROM json_each(:submittedContexts))",
  },
  {
    table: "coordination_operator_attention",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_operator_attention WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_operator_receipts",
    where:
      "EXISTS (SELECT 1 FROM json_each(:operatorReceipts) r WHERE json_extract(r.value,'$.scope')=scope AND json_extract(r.value,'$.key')=commandKey)",
    sql: "DELETE FROM coordination_operator_receipts WHERE EXISTS (SELECT 1 FROM json_each(:operatorReceipts) r WHERE json_extract(r.value,'$.scope')=scope AND json_extract(r.value,'$.key')=commandKey)",
  },
  {
    table: "coordination_question_forms",
    where: "interactionId IN (SELECT value FROM json_each(:interactions))",
    sql: "DELETE FROM coordination_question_forms WHERE interactionId IN (SELECT value FROM json_each(:interactions))",
  },
  {
    table: "coordination_receipts",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM coordination_receipts WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "coordination_recovery_continuations",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM coordination_recovery_continuations WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "coordination_reporting_repairs",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments))",
    sql: "DELETE FROM coordination_reporting_repairs WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments))",
  },
  {
    table: "coordination_runtime_questions",
    where: "interactionId IN (SELECT value FROM json_each(:interactions))",
    sql: "DELETE FROM coordination_runtime_questions WHERE interactionId IN (SELECT value FROM json_each(:interactions))",
  },
  {
    table: "coordination_source_hold_notices",
    where:
      "eventId IN (SELECT value FROM json_each(:events)) OR recipientAssignmentId IN (SELECT value FROM json_each(:assignments))",
    sql: "DELETE FROM coordination_source_hold_notices WHERE eventId IN (SELECT value FROM json_each(:events)) OR recipientAssignmentId IN (SELECT value FROM json_each(:assignments))",
  },
  {
    table: "coordination_task_comment_deliveries",
    where:
      "commentId IN (SELECT value FROM json_each(:comments)) OR recipientAssignmentId IN (SELECT value FROM json_each(:assignments)) OR eventId IN (SELECT value FROM json_each(:events))",
    sql: "DELETE FROM coordination_task_comment_deliveries WHERE commentId IN (SELECT value FROM json_each(:comments)) OR recipientAssignmentId IN (SELECT value FROM json_each(:assignments)) OR eventId IN (SELECT value FROM json_each(:events))",
  },
  {
    table: "coordination_unresolved_result_destinations",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments))",
    sql: "DELETE FROM coordination_unresolved_result_destinations WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments))",
  },
  {
    table: "delivery_approval_bindings",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments))",
    sql: "DELETE FROM delivery_approval_bindings WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments))",
  },
  {
    table: "delivery_attempts",
    where: "operationId IN (SELECT value FROM json_each(:deliveryOperations))",
    sql: "DELETE FROM delivery_attempts WHERE operationId IN (SELECT value FROM json_each(:deliveryOperations))",
  },
  {
    table: "delivery_closure_versions",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM delivery_closure_versions WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "delivery_observations",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM delivery_observations WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "delivery_operator_comment_reviews",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM delivery_operator_comment_reviews WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "delivery_operator_confirm_receipts",
    where: "key IN (SELECT value FROM json_each(:deliveryConfirmKeys))",
    sql: "DELETE FROM delivery_operator_confirm_receipts WHERE key IN (SELECT value FROM json_each(:deliveryConfirmKeys))",
  },
  {
    table: "delivery_policies",
    where: "projectId = :projectId",
    sql: "DELETE FROM delivery_policies WHERE projectId = :projectId",
  },
  {
    table: "delivery_pr_bindings",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM delivery_pr_bindings WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "delivery_readiness_coverage",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM delivery_readiness_coverage WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "delivery_settlement_readiness",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM delivery_settlement_readiness WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "delivery_settlement_receipts",
    where: "commandKey IN (SELECT value FROM json_each(:settlementKeys))",
    sql: "DELETE FROM delivery_settlement_receipts WHERE commandKey IN (SELECT value FROM json_each(:settlementKeys))",
  },
  {
    table: "delivery_task_branches",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM delivery_task_branches WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "delivery_waiting_work",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM delivery_waiting_work WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "diagnostic_executions",
    where:
      "projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM diagnostic_executions WHERE projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "diagnostic_gaps",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM diagnostic_gaps WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "diagnostic_items",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM diagnostic_items WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "drafting_command_receipts",
    where: "key IN (SELECT value FROM json_each(:draftReceiptKeys))",
    sql: "DELETE FROM drafting_command_receipts WHERE key IN (SELECT value FROM json_each(:draftReceiptKeys))",
  },
  {
    table: "drafting_runs",
    where:
      "projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM drafting_runs WHERE projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "drafting_workspace_bindings",
    where: "taskId IN (SELECT value FROM json_each(:drafts))",
    sql: "DELETE FROM drafting_workspace_bindings WHERE taskId IN (SELECT value FROM json_each(:drafts))",
  },
  {
    table: "execution_capacity_reservations",
    where:
      "projectId = :projectId OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_capacity_reservations WHERE projectId = :projectId OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_intent_network_access",
    where: "intentId IN (SELECT value FROM json_each(:intents))",
    sql: "DELETE FROM execution_intent_network_access WHERE intentId IN (SELECT value FROM json_each(:intents))",
  },
  {
    table: "execution_no_turn_receipts",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_no_turn_receipts WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_pending_effects",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_pending_effects WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_power_reconciliation_pending",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_power_reconciliation_pending WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_pre_turn_commands",
    where: "commandKey IN (SELECT value FROM json_each(:preTurnKeys))",
    sql: "DELETE FROM execution_pre_turn_commands WHERE commandKey IN (SELECT value FROM json_each(:preTurnKeys))",
  },
  {
    table: "execution_pre_turn_receipts",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_pre_turn_receipts WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_recovery_identities",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_recovery_identities WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_recovery_observations",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_recovery_observations WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_request_predecessors",
    where:
      "workId IN (SELECT value FROM json_each(:work)) OR previousWorkId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_request_predecessors WHERE workId IN (SELECT value FROM json_each(:work)) OR previousWorkId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_request_refusals",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_request_refusals WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_retry_attempts",
    where:
      "workId IN (SELECT value FROM json_each(:work)) OR chainId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_retry_attempts WHERE workId IN (SELECT value FROM json_each(:work)) OR chainId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_retry_generations",
    where:
      "workId IN (SELECT value FROM json_each(:work)) OR chainId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_retry_generations WHERE workId IN (SELECT value FROM json_each(:work)) OR chainId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_retry_resolutions",
    where:
      "failedWorkId IN (SELECT value FROM json_each(:work)) OR retryWorkId IN (SELECT value FROM json_each(:work)) OR chainId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_retry_resolutions WHERE failedWorkId IN (SELECT value FROM json_each(:work)) OR retryWorkId IN (SELECT value FROM json_each(:work)) OR chainId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_shutdown_resolutions",
    where:
      "interruptedWorkId IN (SELECT value FROM json_each(:work)) OR requeueWorkId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_shutdown_resolutions WHERE interruptedWorkId IN (SELECT value FROM json_each(:work)) OR requeueWorkId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_stop_targets",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_stop_targets WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_turn_skill_plugins",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_turn_skill_plugins WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "imported_tasks",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM imported_tasks WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "inbox_request_anchors",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM inbox_request_anchors WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "inbox_request_supersessions",
    where:
      "oldWorkId IN (SELECT value FROM json_each(:work)) OR newWorkId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM inbox_request_supersessions WHERE oldWorkId IN (SELECT value FROM json_each(:work)) OR newWorkId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "lead_text_confirmed",
    where:
      "assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM lead_text_confirmed WHERE assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "local_dependencies",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR blockerTaskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM local_dependencies WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR blockerTaskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "project_active_selections",
    where: "projectId = :projectId",
    sql: "DELETE FROM project_active_selections WHERE projectId = :projectId",
  },
  {
    table: "project_command_network_access",
    where: "projectId = :projectId",
    sql: "DELETE FROM project_command_network_access WHERE projectId = :projectId",
  },
  {
    table: "project_diagnostic_capture",
    where: "projectId = :projectId",
    sql: "DELETE FROM project_diagnostic_capture WHERE projectId = :projectId",
  },
  {
    table: "project_instruction_revisions",
    where: "projectId = :projectId",
    sql: "DELETE FROM project_instruction_revisions WHERE projectId = :projectId",
  },
  {
    table: "project_repository_links",
    where: "projectId = :projectId",
    sql: "DELETE FROM project_repository_links WHERE projectId = :projectId",
  },
  {
    table: "project_routing",
    where: "projectId = :projectId",
    sql: "DELETE FROM project_routing WHERE projectId = :projectId",
  },
  {
    table: "project_stacking",
    where: "projectId = :projectId",
    sql: "DELETE FROM project_stacking WHERE projectId = :projectId",
  },
  {
    table: "project_task_sources",
    where: "projectId = :projectId",
    sql: "DELETE FROM project_task_sources WHERE projectId = :projectId",
  },
  {
    table: "retained_result_evidence_items",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM retained_result_evidence_items WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "retained_review_anchor_draft_refs",
    where:
      "draftId IN (SELECT value FROM json_each(:anchorDrafts)) OR anchorId IN (SELECT value FROM json_each(:anchors))",
    sql: "DELETE FROM retained_review_anchor_draft_refs WHERE draftId IN (SELECT value FROM json_each(:anchorDrafts)) OR anchorId IN (SELECT value FROM json_each(:anchors))",
  },
  {
    table: "retained_review_anchor_draft_submissions",
    where:
      "draftId IN (SELECT value FROM json_each(:anchorDrafts)) OR submittedContextId IN (SELECT value FROM json_each(:submittedContexts))",
    sql: "DELETE FROM retained_review_anchor_draft_submissions WHERE draftId IN (SELECT value FROM json_each(:anchorDrafts)) OR submittedContextId IN (SELECT value FROM json_each(:submittedContexts))",
  },
  {
    table: "retained_review_anchor_operations",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM retained_review_anchor_operations WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "retained_review_anchor_submitted_refs",
    where:
      "submittedContextId IN (SELECT value FROM json_each(:submittedContexts)) OR anchorId IN (SELECT value FROM json_each(:anchors))",
    sql: "DELETE FROM retained_review_anchor_submitted_refs WHERE submittedContextId IN (SELECT value FROM json_each(:submittedContexts)) OR anchorId IN (SELECT value FROM json_each(:anchors))",
  },
  {
    table: "routing_attempts",
    where: "operationId IN (SELECT value FROM json_each(:routingOperations))",
    sql: "DELETE FROM routing_attempts WHERE operationId IN (SELECT value FROM json_each(:routingOperations))",
  },
  {
    table: "runtime_terminal_evidence",
    where:
      "workId IN (SELECT value FROM json_each(:work)) OR threadId IN (SELECT value FROM json_each(:threads))",
    sql: "DELETE FROM runtime_terminal_evidence WHERE workId IN (SELECT value FROM json_each(:work)) OR threadId IN (SELECT value FROM json_each(:threads))",
  },
  {
    table: "runtime_thread_qualification",
    where: "threadId IN (SELECT value FROM json_each(:threads))",
    sql: "DELETE FROM runtime_thread_qualification WHERE threadId IN (SELECT value FROM json_each(:threads))",
  },
  {
    table: "scheduler_project_capacity_limits",
    where: "projectId = :projectId",
    sql: "DELETE FROM scheduler_project_capacity_limits WHERE projectId = :projectId",
  },
  {
    table: "source_completions",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM source_completions WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "source_dependency_observations",
    where:
      "EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
    sql: "DELETE FROM source_dependency_observations WHERE EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
  },
  {
    table: "source_holds",
    where:
      "EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
    sql: "DELETE FROM source_holds WHERE EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
  },
  {
    table: "source_issue_briefs",
    where:
      "EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
    sql: "DELETE FROM source_issue_briefs WHERE EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
  },
  {
    table: "source_memberships",
    where:
      "projectId = :projectId OR EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
    sql: "DELETE FROM source_memberships WHERE projectId = :projectId OR EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
  },
  {
    table: "source_native_blockers",
    where:
      "EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
    sql: "DELETE FROM source_native_blockers WHERE EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
  },
  {
    table: "source_placement_decisions",
    where:
      "projectId = :projectId OR EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
    sql: "DELETE FROM source_placement_decisions WHERE projectId = :projectId OR EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
  },
  {
    table: "source_review_decisions",
    where:
      "EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
    sql: "DELETE FROM source_review_decisions WHERE EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
  },
  {
    table: "source_sync_state",
    where: "projectId = :projectId",
    sql: "DELETE FROM source_sync_state WHERE projectId = :projectId",
  },
  {
    table: "stacked_dependencies",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR blockerTaskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM stacked_dependencies WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR blockerTaskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "status_mapping_task_state",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM status_mapping_task_state WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "status_mappings",
    where: "projectId = :projectId",
    sql: "DELETE FROM status_mappings WHERE projectId = :projectId",
  },
  {
    table: "task_archival_holds",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_archival_holds WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "task_control_receipts",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_control_receipts WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "task_dependency_records",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR blockerTaskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_dependency_records WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR blockerTaskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "task_execution_results",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM task_execution_results WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "task_handback_text",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_handback_text WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "task_lead_bindings",
    where:
      "projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments))",
    sql: "DELETE FROM task_lead_bindings WHERE projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments))",
  },
  {
    table: "task_publication_receipts",
    where: "key IN (SELECT value FROM json_each(:publicationKeys))",
    sql: "DELETE FROM task_publication_receipts WHERE key IN (SELECT value FROM json_each(:publicationKeys))",
  },
  {
    table: "task_publications",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_publications WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "task_review_contexts",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM task_review_contexts WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "task_review_search",
    where:
      "projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_review_search WHERE projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "task_review_sources",
    where:
      "projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_review_sources WHERE projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "task_review_view_receipts",
    where: "key IN (SELECT value FROM json_each(:viewKeys))",
    sql: "DELETE FROM task_review_view_receipts WHERE key IN (SELECT value FROM json_each(:viewKeys))",
  },
  {
    table: "task_review_viewed",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_review_viewed WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "task_work_revision_ambiguities",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM task_work_revision_ambiguities WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "task_work_revision_pending",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM task_work_revision_pending WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "task_work_revisions",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM task_work_revisions WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "task_workspace_bindings",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_workspace_bindings WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "task_writer_admissions",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM task_writer_admissions WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "task_writer_ambiguity_holds",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_writer_ambiguity_holds WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "task_writer_holds",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_writer_holds WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "turn_request_restarts",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR workId IN (SELECT value FROM json_each(:work)) OR refusedWorkId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM turn_request_restarts WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR workId IN (SELECT value FROM json_each(:work)) OR refusedWorkId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "workspace_comparison_current",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM workspace_comparison_current WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "workspace_turn_capture_slots",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM workspace_turn_capture_slots WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "workspace_turn_captures",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM workspace_turn_captures WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_delivery_batches",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_delivery_batches WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_follow_ups",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_follow_ups WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_inbox_events",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_inbox_events WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_interactions",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_interactions WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_local_review_operations",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_local_review_operations WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_task_comments",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM coordination_task_comments WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "delivery_actions",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM delivery_actions WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "execution_no_turn_submissions",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_no_turn_submissions WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_pre_turn_rejections",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_pre_turn_rejections WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_recovery_receipts",
    where: "workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_recovery_receipts WHERE workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "execution_retry_chains",
    where: "chainId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM execution_retry_chains WHERE chainId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "external_items",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
    sql: "DELETE FROM external_items WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR EXISTS (SELECT 1 FROM json_each(:external) x WHERE json_extract(x.value,'$.provider')=provider AND json_extract(x.value,'$.instance')=instance AND json_extract(x.value,'$.externalId')=externalId)",
  },
  {
    table: "lead_text_submissions",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM lead_text_submissions WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "retained_result_evidence",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM retained_result_evidence WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "retained_review_anchor_contexts",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM retained_review_anchor_contexts WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "retained_review_anchor_drafts",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM retained_review_anchor_drafts WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "routing_attempt_operations",
    where:
      "projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM routing_attempt_operations WHERE projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "task_execution_bindings",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM task_execution_bindings WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "task_review_artifact_ids",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_review_artifact_ids WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "turn_requests",
    where:
      "projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks)) OR taskId IN (SELECT value FROM json_each(:drafts)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM turn_requests WHERE projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks)) OR taskId IN (SELECT value FROM json_each(:drafts)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "retained_review_anchor_submitted_contexts",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM retained_review_anchor_submitted_contexts WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "routing_operations",
    where:
      "projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments))",
    sql: "DELETE FROM routing_operations WHERE projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments))",
  },
  {
    table: "task_review_results",
    where: "taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM task_review_results WHERE taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "coordination_results",
    where:
      "taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
    sql: "DELETE FROM coordination_results WHERE taskId IN (SELECT value FROM json_each(:tasks)) OR assignmentId IN (SELECT value FROM json_each(:assignments)) OR workId IN (SELECT value FROM json_each(:work))",
  },
  {
    table: "domain_assignments",
    where:
      "projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM domain_assignments WHERE projectId = :projectId OR taskId IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "execution_intents",
    where:
      "workId IN (SELECT value FROM json_each(:work)) OR id IN (SELECT value FROM json_each(:intents))",
    sql: "DELETE FROM execution_intents WHERE workId IN (SELECT value FROM json_each(:work)) OR id IN (SELECT value FROM json_each(:intents))",
  },
  {
    table: "domain_tasks",
    where:
      "projectId = :projectId OR id IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM domain_tasks WHERE projectId = :projectId OR id IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "domain_projects",
    where: "id = :projectId",
    sql: "DELETE FROM domain_projects WHERE id = :projectId",
  },
  {
    table: "tasks",
    where:
      "projectId = :projectId OR id IN (SELECT value FROM json_each(:tasks))",
    sql: "DELETE FROM tasks WHERE projectId = :projectId OR id IN (SELECT value FROM json_each(:tasks))",
  },
  {
    table: "projects",
    where: "id = :projectId",
    sql: "DELETE FROM projects WHERE id = :projectId",
  },
] as const;
export type ProjectDeletionTable =
  (typeof projectDeletionStatements)[number]["table"];
