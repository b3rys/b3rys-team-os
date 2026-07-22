/**
 * teamRouter — barrel (re-export).
 *
 * The implementation was split (2026-06-06, strangler refactor) into modules under
 * ./teamRouter/ — mention / gate / legacy / defaultIntake / ownerDecision (+ shared
 * types & helpers). This file stays as the stable entry point so every existing
 * `import { … } from ".../lib/teamRouter"` keeps working unchanged.
 *
 * Module map (Devon guidance: keep mention regexes together, isolate legacy):
 *   _shared       — RouterContext, RouteDecision, RouteIntent, LlmRouteDecision,
 *                   OLLAMA_URL/ROUTER_MODEL, buildRosterText, classifyIntent
 *                   (default_step owner = coordinator capability via lib/capabilities.coordinatorId)
 *   mention       — aliasesFor, hasTelegramMention, hasRestrictedMention, escapeRegex,
 *                   stripExampleRegions, detectExplicitTargets, detectAddressedNamesLoose
 *                   (+ dead code retained: hasAddressedAlias, filterLiveWakeTargets)
 *   gate          — isConfidentOwner, shouldSuppress, leadingAddressee  (ownerGate)
 *   legacy        — hasTopicShift, isClosure  (topic_shift/closure — NOT in current routing path)
 *   defaultIntake — routeDefaultIntakeLLM  (b3rys owner-inference LLM)
 *   ownerDecision — routeTeamMessage (sync fallback), routeTeamMessageLLM, routeTeamMessageHybrid
 */
export * from "./teamRouter/_shared";
export * from "./teamRouter/mention";
export * from "./teamRouter/gate";
export * from "./teamRouter/legacy";
export * from "./teamRouter/defaultIntake";
export * from "./teamRouter/ownerDecision";
