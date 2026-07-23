# mocks/

Phase 1.5 envelope contract 검증용 가짜 agent.

- `mock-poll.sh <me> <partner> <iters>` — 자기 inbox 폴링 + partner 가 보낸 unread 가 있으면 응답 (hop_count+1) + read 처리
- `conversation-test.sh` — 두 mock 스폰 + 초기 메시지 발사 + 결과 assert + cleanup

검증 후 agents.json 에서 mock_alice, mock_bob 항목 제거 + DB 정리.
