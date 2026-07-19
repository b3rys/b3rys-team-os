# TEAM-OS Compaction Summary

## Scope

Branch: `team-os-compact-20260707`

Files produced:

- `rules/TEAM-OS.md`: compact always-load version
- `rules/archive/TEAM-OS.pre-compact-20260707.md`: original preserved
- `rules/TEAM-OS.learning.md`: §9 details
- `rules/TEAM-OS.task-mgmt.md`: §10 task/BWF/harness details
- `rules/TEAM-OS.workloop.md`: workloop details
- `rules/TEAM-OS.concurrent-work.md`: branch/worktree isolation details
- `rules/TEAM-OS.template.ko.md`: Korean review template
- `rules/TEAM-OS.template.ko.min.md`: aggressive Korean minimum-context template
- `rules/TEAM-OS.runtime-loading-dedup.proposal.ko.md`: proposal for reducing CLAUDE/AGENTS duplication by runtime

## What Was Removed From Always-Load

- Long examples and incident narratives
- Dated approval/incident wording
- Runtime product names in rule text
- Person-specific role descriptions
- Detailed task card templates
- Detailed harness sizing prose
- Detailed workloop procedure
- Detailed self-learning/proposal procedure
- Concurrent-work incident story

## Additional Minimum Korean Template

`rules/TEAM-OS.template.ko.min.md` is a second option for the team lead to compare against the fuller Korean template. It keeps:

- owner response routing
- discuss/confirm/execute execution gate
- collaboration core: directed replies, no broadcast, handoff tracking until ack/state, lead coordination
- task core: communication owner vs task owner, completion criteria, drive mode fields, PM conversion for out-of-role execution
- safety approval gates
- `SECTION_CORE_RULE` verification gate
- state invariant: doing, blocked, awaiting-confirmation, done
- on-demand references

Removed from the minimum option:

- mission prose
- collaboration etiquette detail beyond the core
- BWF stage detail
- harness selection detail
- learning/proposal procedure
- workloop procedure
- branch/worktree procedure detail
- full document-structure explanation

## What Was Kept In TEAM-OS.md

- Language matching invariant
- Owner routing rules
- Rule priority
- Ack/confirm-first execution policy
- External-message untrusted-input rule
- Safety/self-mod/external-send/credential/deletion/payment approval gates
- Fact-checking default
- Commit-after-verified-work default
- SECTION_CORE_RULE verification gate
- AI-code safety gate
- BWF minimum contract
- Task carding thresholds
- Workloop one-turn closure contract
- Branch/worktree isolation principles
- Links to on-demand detail

## Genericization

Changed to role/capability terms:

- named humans -> team lead, co-leads, coordinator, owner, reviewer
- runtime product names -> auto-load runtimes, explicit-load runtimes, manual-spawn runtimes
- dated incidents -> general risk statements
- person-specific harness/review wording -> member review, harness verification, capability holder

Kept concrete paths only where they are operational references.

## DO-NOT-COMPACT Check

- `SECTION_CORE_RULE`: kept in §4
- §2 owner rules: kept in §2
- §4 safety/security/external-send/self-mod: kept in §4
- rule-change review/behavior verification: kept in §9 summary and detailed in `rules/TEAM-OS.learning.md`
- core rules moved only as summaries plus references: yes

## Legacy Outbound-Send Search

The compact TEAM-OS files contain no active legacy outbound-send rule text.

Source code still has legacy outbound-send persona paths outside the TEAM-OS documents. The runtime-loading proposal lists those as apply-stage cleanup if the rollback is permanent.

## Verification Notes

Required before final apply/merge:

- diff review by team reviewer
- team lead diff approval
- BWF selftest
- any dashboard/public acceptance checks required by current release gate
