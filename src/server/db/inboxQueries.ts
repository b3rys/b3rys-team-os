/**
 * inboxQueries — barrel (re-export).
 *
 * The implementation was split (2026-06-06, strangler refactor) into domain modules
 * under ./inbox/ — messages / dispatch / stats / lifecycle (+ shared row mappers).
 * This file stays as the stable entry point so every existing
 * `import { … } from ".../db/inboxQueries"` keeps working unchanged.
 *
 * Domain map:
 *   _shared    — toIso, rowToEnvelope, MessageRow/ThreadRow, RESOLVE_GRACE_SECONDS
 *   messages   — ensureThread, insertMessage, inboxFor, markRead, getThread,
 *                recentThreadMessages, findRouteByTgMessageId, findSlackMetaForThread
 *   dispatch   — pendingDispatch, markDispatching, markWakeDispatched, markAck,
 *                markFailed, markDeferred, recoverStaleClaims, aggregateDeliveryStatus,
 *                messagesWithAggregatedStatus
 *   stats      — agentStats, recentAlerts, agentActivity, listThreads,
 *                busStatusSnapshot, busFlowRecent, busMemberStatus
 *   lifecycle  — findRecentDuplicate, expireOverdueMessages, listOpenInflightThreads,
 *                countAutoRounds, resolvePendingForAgent
 */
export * from "./inbox/_shared";
export * from "./inbox/messages";
export * from "./inbox/dispatch";
export * from "./inbox/stats";
export * from "./inbox/lifecycle";
export * from "./inbox/acceptInbound";
