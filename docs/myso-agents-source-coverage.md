# MySo Agents source coverage baseline

October 24, 2026. Planning evidence only. Source was read; no product code, test or runtime was executed. Plan approval is still pending.

## Findings

- catalogActions: **110**
- catalogEnabled: **73**
- catalogBlocked: **37**
- dedicatedActionToolsAdvertised: **32**
- enabledActionsWithoutDedicatedMcpTool: **41**
- extraRegisteredActions: **2**
- advertisedGatewayTools: **42**
- memoryTools: **3**
- routeDeclarations: **319**
- publicRouteDeclarations: **309**
- messagingSdkMethods: **36**

The direct-tool count matches normalized action names to the actual gateway advertisement, with explicit name mappings for react and root-agent tools. It does not count generic approval helpers as direct capability execution. Runtime authorization and deployed availability remain unverified.

Two independent inventories must be reconciled: the production catalog and the executable registry. Registered social deletion actions exist outside the production catalog, while deletion tools are not advertised by the gateway. Do not silently drop these from the scope or blindly enable them.

## All catalog actions

| Action | Catalog availability | Registry | Dedicated MCP tool | Remaining work |
|---|---|---|---|---|
| `social.react_to_post.v1` | enabled | reactToPost | social_react_post | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.remove_post_reaction.v1` | enabled | removePostReaction | social_remove_post_reaction | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.react_to_comment.v1` | enabled | reactToComment | social_react_comment | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.remove_comment_reaction.v1` | enabled | removeCommentReaction | social_remove_comment_reaction | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.create_post.v1` | enabled | createPost | social_create_post | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.edit_post.v1` | enabled | editPost | social_edit_post | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.create_comment.v1` | enabled | createComment | social_create_comment | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.edit_comment.v1` | enabled | editComment | social_edit_comment | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.create_repost.v1` | enabled | createRepost | social_create_repost | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.remove_repost.v1` | enabled | removeRepost | social_remove_repost | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.follow_profile.v1` | enabled | followProfile | social_follow_profile | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.unfollow_profile.v1` | enabled | unfollowProfile | social_unfollow_profile | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.block_profile.v1` | enabled | blockProfile | social_block_profile | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `social.unblock_profile.v1` | enabled | unblockProfile | social_unblock_profile | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `messaging.send_message.v1` | enabled | sendMessage | messaging_send_message | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `messaging.create_group.v1` | enabled | createMessagingGroup | messaging_create_group | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `organization.accept_invitation.v1` | enabled | acceptOrganizationInvitation | organization_accept_invitation | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `organization.decline_invitation.v1` | enabled | declineOrganizationInvitation | organization_decline_invitation | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `agent.register_child.v1` | enabled | registerChildAgent | agent_register_child | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `agent.update_child.v1` | enabled | updateManagedAgent | agent_update_child | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `agent.deactivate_child.v1` | enabled | deactivateManagedAgent | agent_deactivate_child | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `agent.revoke_child.v1` | enabled | revokeManagedAgent | agent_revoke_child | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `task.create.v1` | enabled | taskCreate | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.accept.v1` | enabled | taskAccept | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.decline.v1` | enabled | taskDecline | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.cancel_offer.v1` | enabled | taskCancelOffer | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.deliver.v1` | enabled | taskDeliver | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.settle.v1` | enabled | taskSettle | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.refund.v1` | enabled | taskRefund | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.release.v1` | enabled | taskRelease | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.expire_offer.v1` | enabled | taskExpireOffer | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.propose_refund.v1` | enabled | taskProposeRefund | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.accept_refund.v1` | enabled | taskAcceptRefund | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.reject_refund.v1` | enabled | taskRejectRefund | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.withdraw_refund.v1` | enabled | taskWithdrawRefund | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.review.v1` | enabled | taskReview | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.open_dispute.v1` | enabled | taskOpenDispute | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.respond_dispute.v1` | enabled | taskRespondDispute | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.submit_evidence.v1` | enabled | taskSubmitEvidence | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.appeal.v1` | enabled | taskAppeal | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.cancel_dispute.v1` | enabled | taskCancelDispute | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.propose_dispute_settlement.v1` | enabled | taskProposeDisputeSettlement | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.accept_dispute_settlement.v1` | enabled | taskAcceptDisputeSettlement | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `task.clear_dispute_settlement.v1` | enabled | taskClearDisputeSettlement | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.accept.v1` | enabled | juryAccept | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.commit_vote.v1` | enabled | juryCommitVote | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.reveal_vote.v1` | enabled | juryRevealVote | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.claim_fee.v1` | enabled | juryClaimFee | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.select_jury.v1` | enabled | jurySelect | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.replace_no_shows.v1` | enabled | juryReplaceNoShows | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.finalize_round.v1` | enabled | juryFinalizeRound | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.finalize_case.v1` | enabled | juryFinalizeCase | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.execute_task_verdict.v1` | enabled | juryExecuteTaskVerdict | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.start_neutral_resolution.v1` | enabled | juryStartNeutral | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.execute_neutral_resolution.v1` | enabled | juryExecuteNeutral | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.settle_dispute_fees.v1` | enabled | jurySettleFees | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.escalate_proposal.v1` | enabled | juryEscalateProposal | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.finalize_proposal.v1` | enabled | juryFinalizeProposal | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.apply_proposal_decision.v1` | enabled | juryApplyDecision | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.sweep_case.v1` | enabled | jurySweepCase | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.sweep_vote_refunds.v1` | enabled | jurySweepVoteRefunds | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.refresh_roster_entry.v1` | enabled | juryRefreshRoster | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `jury.evict_ineligible.v1` | enabled | juryEvict | absent | add dedicated MCP callable exposure and auth/scope mapping |
| `payments.tip_profile.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `payments.tip_post.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `payments.send_token.v1` | protocol-adapter-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `subscription.subscribe_to_plan.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `subscription.renew_subscription.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `subscription.cancel_subscription.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `subscription.enable_auto_renew.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `subscription.disable_auto_renew.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `access.purchase_post_access.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `access.purchase_mydata_access.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `access.share_mydata.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `access.revoke_mydata_share.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `spt.buy.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `spt.sell.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `spot.create_market.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `spot.place_bet.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `spot.claim_payout.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `storage.purchase_capacity.v1` | protocol-adapter-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `dex.swap.v1` | protocol-adapter-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `bridge.initiate_transfer.v1` | protocol-adapter-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `organization.create.v1` | enabled | createOrganization | organization_create | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `organization.update_metadata.v1` | enabled | updateOrganizationMetadata | organization_update_metadata | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `organization.update_category.v1` | enabled | updateOrganizationCategory | organization_update_category | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `organization.deactivate.v1` | enabled | deactivateOrganization | organization_deactivate | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `organization.ensure_memory_group.v1` | enabled | ensureOrganizationMemoryGroup | organization_ensure_memory_group | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `organization.define_role.v1` | enabled | defineOrganizationRole | organization_define_role | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `organization.assign_role.v1` | enabled | assignOrganizationRole | organization_assign_role | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `organization.revoke_role.v1` | enabled | revokeOrganizationRole | organization_revoke_role | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `organization.create_invitation.v1` | enabled | createOrganizationInvitation | organization_create_invitation | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `agent.register_agent.v1` | enabled | registerRootAgent | agent_register_root | existing direct exposure; audit actual deployed scope and end-to-end contract |
| `agent.revoke_agent.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `agent.grant_capability.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `agent.revoke_capability.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `agent.raise_spending_limit.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `account.rotate_owner_key.v1` | protocol-adapter-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `account.configure_multisig.v1` | protocol-adapter-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `poc.claim_creator_vault.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `poc.transfer_beneficiary_rights.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `governance.vote.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `governance.delegate_vote.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `assets.transfer_object.v1` | protocol-adapter-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `assets.burn_object.v1` | protocol-adapter-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `platform.transfer_platform.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `platform.update_fee_recipient.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `organization.grant_treasury_access.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `organization.withdraw_treasury.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |
| `subscription.change_service_payment_recipient.v1` | transaction-builder-required | absent | absent | implement deterministic builder/adapter, resolver, policy and effect parser; then expose MCP |

## Additional registered actions

- `social.delete_post.v1`: Registered action is outside production catalog and absent from gateway supported-tool list; reconcile policy/catalog before declaring coverage.
- `social.delete_comment.v1`: Registered action is outside production catalog and absent from gateway supported-tool list; reconcile policy/catalog before declaring coverage.

## Route and SDK evidence

The JSON companion records every route declaration found in the inspected social, memory and automation route roots, plus messaging SDK methods. Routes are raw declarations, not a claim that all are suitable for end-user MCP exposure. Each item carries the source path and line; source hashes make the baseline auditable. Internal routes must stay behind trusted service boundaries.

Use this baseline to assign action implementations and read/list wrappers during approved implementation. New graph services, durable automation delivery and task harness behavior are separate new work described in the plan.
