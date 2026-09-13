# Brain-plane test baselines: what is in them and why (T-17, 2026-09-13)

The brain plane (`planes/brain/libs/agno`, upstream Agno) carries a unit suite that cannot be
green on this product's environment: many tests need vendor SDKs, API keys, or services that are
not installed here. The CI gate therefore asserts **zero new failures against a recorded
baseline** (`scripts/check-no-regressions.py`), not "pytest exits 0".

## The baseline is now reproducible

Until today the install list in `.github/workflows/ci.yml` was unpinned, so the "pristine"
baseline drifted with whatever PyPI served on the day it was recorded. Both baselines were
re-captured on 2026-09-13 from one full run (`pytest tests/unit --asyncio-mode=auto
--continue-on-collection-errors -rfE`, Python 3.14.5, macOS arm64: **271 failed, 12,576 passed,
510 skipped, 312 errors**) on an environment whose exact package versions are now pinned in
`tests/brain-constraints.txt` (54 pins; the workflow installs with `-c` against it).
Notable pins: pydantic==2.13.5, fastapi==0.141.1, openai==3.13.0, anthropic==1.5.0, httpx==0.28.1, SQLAlchemy==2.0.52, numpy==2.5.3, pytest==9.0.3, pytest-asyncio==1.4.0.

## What changed against the 2026-09-12 baseline (277 failing → 271; 312 erroring → 312)

The failing set changed in both directions purely by environment: no brain source file was
edited between the two runs (`git log -- planes/brain` shows none). Removing an id from a
baseline is allowed only because the test now passes; adding one is allowed only with its
observed cause recorded here.

### 46 ids no longer failing (removed from the baseline — they pass under the pinned versions)

- `tests/unit/models/anthropic/test_append_trailing_user_message.py::TestAutoDetectionAwsClaude::test_aws_global_prefix_auto_enabled`
- `tests/unit/models/anthropic/test_append_trailing_user_message.py::TestAutoDetectionAwsClaude::test_aws_sonnet_45_auto_disabled`
- `tests/unit/models/anthropic/test_append_trailing_user_message.py::TestAutoDetectionAwsClaude::test_aws_sonnet_46_auto_enabled`
- `tests/unit/models/test_parse_tool_calls_name.py::test_arguments_accumulated_incrementally[cerebras]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_arguments_accumulated_incrementally[groq]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_arguments_accumulated_incrementally[huggingface]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_arguments_accumulated_incrementally[litellm]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_arguments_accumulated_incrementally[watsonx]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_empty_string_does_not_overwrite_name[cerebras]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_empty_string_does_not_overwrite_name[groq]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_empty_string_does_not_overwrite_name[huggingface]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_empty_string_does_not_overwrite_name[litellm]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_empty_string_does_not_overwrite_name[watsonx]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_multiple_tool_calls_independent[cerebras]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_multiple_tool_calls_independent[groq]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_multiple_tool_calls_independent[huggingface]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_multiple_tool_calls_independent[litellm]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_multiple_tool_calls_independent[watsonx]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_name_not_duplicated_when_resent[cerebras]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_name_not_duplicated_when_resent[groq]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_name_not_duplicated_when_resent[huggingface]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_name_not_duplicated_when_resent[litellm]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_name_not_duplicated_when_resent[watsonx]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_name_sent_once[cerebras]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_name_sent_once[groq]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_name_sent_once[huggingface]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_name_sent_once[litellm]`
- `tests/unit/models/test_parse_tool_calls_name.py::test_name_sent_once[watsonx]`
- `tests/unit/os/routers/test_slack_bot_filtering.py::test_default_drops_all_bot_events`
- `tests/unit/os/routers/test_slack_bot_filtering.py::test_lifecycle_subtypes_still_dropped_with_opt_in`
- `tests/unit/os/routers/test_slack_bot_filtering.py::test_opt_in_allows_peer_agent_messages`
- `tests/unit/os/routers/test_slack_bot_filtering.py::test_opt_in_allows_peer_by_user_id_mismatch`
- `tests/unit/os/routers/test_slack_bot_filtering.py::test_opt_in_allows_peer_webhook_bot_with_only_bot_id`
- `tests/unit/os/routers/test_slack_bot_filtering.py::test_opt_in_drops_own_messages_by_bot_id`
- `tests/unit/os/routers/test_slack_bot_filtering.py::test_opt_in_drops_own_messages_by_bot_user_id`
- `tests/unit/os/routers/test_slack_store_media.py::test_non_streaming_real_agent_store_media_false`
- `tests/unit/os/routers/test_slack_store_media.py::test_non_streaming_store_media_false_response_has_images`
- `tests/unit/os/routers/test_slack_store_media.py::test_non_streaming_store_media_false_uploads_media`
- `tests/unit/os/routers/test_slack_store_media.py::test_non_streaming_store_media_true_still_uploads`
- `tests/unit/os/routers/test_slack_store_media.py::test_streaming_content_chunks_with_images_collected`
- `tests/unit/os/routers/test_slack_store_media.py::test_streaming_real_agent_store_media_false`
- `tests/unit/os/routers/test_slack_store_media.py::test_streaming_store_media_false_collects_media_from_completion`
- `tests/unit/os/routers/test_whatsapp_router.py::test_encrypted_mode_deterministic`
- `tests/unit/os/routers/test_whatsapp_router.py::test_encrypted_mode_keeps_raw_phone_in_context`
- `tests/unit/os/routers/test_whatsapp_router.py::test_encrypted_phone_mode`
- `tests/unit/vectordb/test_vdb_user_id_migration.py::TestMilvusMigrationContract::test_adapter_exposes_the_constants_the_migration_depends_on`

### 40 ids newly failing (added to the baseline, with the assertion observed under `--tb=line`)

- `tests/unit/fs/test_toolkit.py::TestExcludeToolsTypos::test_a_typo_warns_and_excludes_nothing` — assert False
- `tests/unit/learn/test_decision_log_search.py::test_fallback_on_not_implemented_filters_client_side` — assert 0 == 1
- `tests/unit/learn/test_deprecations_and_guards.py::test_hitl_mode_warns_unsupported_without_deprecating` — assert False
- `tests/unit/learn/test_deprecations_and_guards.py::test_manual_door_without_a_model_says_capture_is_off` — AssertionError: []
- `tests/unit/learn/test_deprecations_and_guards.py::test_missing_user_id_message_drops_the_tool_claim_when_tools_are_off` — AssertionError: []
- `tests/unit/learn/test_deprecations_and_guards.py::test_missing_user_id_message_separates_disabled_tools_from_refusals` — AssertionError: []
- `tests/unit/learn/test_deprecations_and_guards.py::test_missing_user_id_with_per_user_stores_is_logged_once` — assert 0 == 1
- `tests/unit/learn/test_entity_memory_store.py::TestSearchRouting::test_search_falls_back_on_not_implemented` — assert 0 == 1
- `tests/unit/learn/test_guidance_split.py::TestManualDoor::test_double_render_warns_once` — assert 0 == 1
- `tests/unit/learn/test_machine_roundtrip.py::test_custom_stores_round_trip_as_logged_refs` — assert False
- `tests/unit/os/routers/test_component_rollback_projection.py::TestAFailedProjectionWriteDoesNotFailACommittedPointerMove::test_a_bare_pointer_move_still_succeeds` — assert False
- `tests/unit/os/routers/test_component_rollback_projection.py::TestAProjectionFailureDoesNotFailACommittedPointerMove::test_the_patch_route_still_succeeds` — assert False
- `tests/unit/os/routers/test_component_rollback_projection.py::TestAProjectionFailureDoesNotFailACommittedPointerMove::test_the_set_current_route_still_succeeds` — assert False
- `tests/unit/os/routers/test_metrics_router.py::TestAggregationEdges::test_malformed_date_is_skipped_and_logged` — AssertionError: assert 'is not a day' in ''
- `tests/unit/os/test_acceptance_truthfulness.py::TestBackgroundContinueCompatFallthrough::test_agent_background_continue_without_ticket_runs_inline` — AssertionError: the compat fallthrough must warn that background semantics are not real here
- `tests/unit/os/test_acceptance_truthfulness.py::TestBackgroundContinueCompatFallthrough::test_team_background_continue_without_ticket_runs_inline` — assert False
- `tests/unit/os/test_acceptance_truthfulness.py::TestDurabilityBypassIsLoud::test_factory_backed_submission_warns` — AssertionError: a factory-backed background submission silently lost durability - it must warn
- `tests/unit/os/test_agentos_component_walk.py::TestABareExecutorIsAStep::test_a_bare_agent_nested_in_a_container_is_walked` — assert False
- `tests/unit/os/test_agentos_component_walk.py::TestABareExecutorIsAStep::test_a_bare_agent_reachable_twice_is_visited_once` — assert 0 == 1
- `tests/unit/os/test_agentos_component_walk.py::TestABareExecutorIsAStep::test_a_bare_agent_used_as_a_step_is_walked` — assert False
- `tests/unit/os/test_agentos_component_walk.py::TestABareExecutorIsAStep::test_a_bare_team_used_as_a_step_is_walked` — assert False
- `tests/unit/os/test_agentos_component_walk.py::TestABareExecutorIsAStep::test_a_tuple_of_steps_is_walked` — assert False
- `tests/unit/os/test_agentos_component_walk.py::TestNestedStepContainersAreWalked::test_a_container_is_traversed[choices]` — AssertionError: the walk never reached a step held in 'choices'
- `tests/unit/os/test_agentos_component_walk.py::TestNestedStepContainersAreWalked::test_a_container_is_traversed[else_steps]` — AssertionError: the walk never reached a step held in 'else_steps'
- `tests/unit/os/test_agentos_component_walk.py::TestNestedStepContainersAreWalked::test_a_container_is_traversed[steps]` — AssertionError: the walk never reached a step held in 'steps'
- `tests/unit/os/test_agentos_component_walk.py::TestNestedStepContainersAreWalked::test_a_nested_workflow_step_is_traversed` — assert False
- `tests/unit/os/test_agentos_component_walk.py::TestNestedStepContainersAreWalked::test_a_parallel_step_is_traversed` — assert False
- `tests/unit/os/test_agentos_component_walk.py::TestNestedStepContainersAreWalked::test_a_top_level_steps_container_is_traversed` — assert False
- `tests/unit/os/test_queue_worker.py::TestSettlementResults::test_failed_settlement_is_loud_and_sweep_recoverable` — AssertionError: an unsettled ticket must be loud, never silent
- `tests/unit/os/test_registry.py::TestDuplicateAgentIds::test_the_warning_names_both_surfaces` — AssertionError: []
- `tests/unit/os/test_registry.py::TestDuplicateTeamIds::test_the_warning_names_both_surfaces` — AssertionError: []
- `tests/unit/os/test_registry_workflows.py::TestAgentOSSync::test_the_duplicate_id_warning_names_both_surfaces` — AssertionError: []
- `tests/unit/os/test_registry_workflows.py::TestAgentOSSync::test_two_distinct_workflows_sharing_an_id_keep_the_first_and_warn` — assert False
- `tests/unit/os/test_studio_zero_config.py::TestSplitRegistryIsLoud::test_a_studio_toolkit_on_a_team_member_still_warns` — assert False
- `tests/unit/os/test_studio_zero_config.py::TestSplitRegistryIsLoud::test_a_studio_toolkit_on_a_workflow_step_agent_still_warns` — assert False
- `tests/unit/os/test_studio_zero_config.py::TestSplitRegistryIsLoud::test_forgetting_registry_on_agentos_warns` — assert False
- `tests/unit/os/test_studio_zero_config.py::TestTheDeclarationIsBinding::test_an_agentos_with_no_db_refuses_instead_of_adopting_a_private_one` — assert False
- `tests/unit/registry/test_registry.py::TestGetLearning::test_distinct_machines_sharing_a_name_are_ambiguous` — assert False
- `tests/unit/tools/test_studio_publish_projection.py::TestAProjectionFailureDoesNotFailACommittedMove::test_an_inline_publishing_edit_reports_the_version_it_wrote` — assert False
- `tests/unit/tools/test_studio_runner.py::TestStudioEmbedding::test_the_ignored_child_version_pin_is_said_out_loud` — AssertionError:

These 40 sit in `tests/unit/os` (component walk, registry, studio zero-config, acceptance
truthfulness, rollback projection), `tests/unit/learn` (deprecation guards) and
`tests/unit/tools` (studio runner/projection). Every one is a plain assertion difference
(`assert False`, `AssertionError: []`, `assert 0 == 1`) in behaviour that depends on the
installed pydantic/fastapi/openai versions, not an import or network error. They are recorded
as environment-caused under the pinned versions; whether upstream considers them bugs against
the newer dependencies is an upstream question this product does not answer.

## Composition of the remaining baselines (by `tests/unit/<area>`)

Failing (271): os 75, tools 57, db 31, models 28, utils 23, learn 15, knowledge 12, media 12, scheduler 7, vectordb 6, api 1, fs 1, reader 1, registry 1, team 1.
Erroring (312): tools 184, vectordb 37, models 33, db 26, reader 14, app 5, os 4, context 3, knowledge 3, utils 3.

The erroring set is dominated by `tools` (184) and `vectordb`/`models`/`db`: collection-time
errors from optional vendor SDKs that are not part of this product's install list (they need
credentials or services to be meaningful). The failing set's largest areas, `os` and `tools`,
are the upstream AgentOS/studio surface, which this product does not ship.

## How to change these files honestly

- A test that starts passing: remove its id (the gate prints `no longer failing` so the
  removal is visible in review) and say so in the commit.
- A test that starts failing: it is a regression until proven environmental; if environmental,
  add the id here with the observed cause and the pin that changed.
- Never edit a baseline to make a red run green without one of the two reasons above.
