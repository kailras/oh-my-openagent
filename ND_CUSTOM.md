# nd custom — 나만의 oh-my-openagent

이 브랜치(`nd/custom`)는 nd-work-command 대시보드(`~/Projects/nd-work-command`)가 쓰는 OpenCode 엔진 전용 oh-my-openagent입니다. 업스트림을 그대로 따라가지 않고, **검증한 릴리스(v5.1.19)를 기준으로 이 환경에 필요한 것만 더하고 고칩니다.**

- 기준: 업스트림 태그 `v5.1.19` (2026-10-05). 버전 표기는 `5.1.19-nd.<n>` — 바꿀 때마다 `n`을 올립니다.
- 쓰는 곳: OpenCode 1.18.34 `opencode serve`(헤드리스) + 대시보드. OMO Desktop·Senpi·Codex Light·Windows·tmux·팀 모드·TUI 전용 기능은 이 환경에서 쓰지 않습니다.
- 대시보드가 기대는 동작(삽입 메시지 표식, 계획 체크리스트 규칙, `boulder.json` 모양, 에이전트·카테고리 이름, Hephaestus 모델 제약)은 바꾸지 않습니다. 바꿔야 하면 대시보드 테스트와 함께 바꿉니다.

## 바꾼 것

| 영역 | 내용 | 파일 |
|---|---|---|
| 구독 한도 관측 | 엔진이 보내는 Claude 요청(`api.anthropic.com/v1/messages`)과 ChatGPT 요청(`chatgpt.com/backend-api/codex/responses`)의 **응답 헤더 중** `anthropic-ratelimit-unified-*`·`x-codex-*`만 `~/.cache/oh-my-opencode/usage/<anthropic\|openai>.json`에 남깁니다(2초에 한 번 — 쓰기에 실패해도 다음 시도는 2초 뒤, 권한 600, 프로세스마다 다른 임시 파일로 한 번에 교체). 요청 헤더(OAuth 토큰)와 본문은 읽지 않고, 응답 객체는 그대로 돌려줍니다. 끄기: `OMO_ND_USAGE_OBSERVER=0`, 위치 바꾸기: `OMO_ND_USAGE_DIR` | `packages/omo-opencode/src/features/nd-usage-observer/` |
| 텔레메트리 | 익명 사용 통계를 **기본으로 보내지 않음**(업스트림은 기본 전송). `telemetry: true` 또는 `OMO_SEND_ANONYMOUS_TELEMETRY=1`일 때만 보냄 | `packages/omo-opencode/src/shared/posthog.ts` |
| postinstall | 이 저장소에서 `bun install`을 하면 업스트림 postinstall이 OpenCode의 플러그인 캐시(`~/.cache/opencode/packages/oh-my-openagent@*`)를 지웁니다 — 실행 중인 엔진이 읽는 파일이 사라짐(2026-10-13 실제로 발생). 설치된 사본(`node_modules` 아래)일 때만 지우게 함 | `postinstall.mjs` |
| 빌드 | `opencode-plugin` 빌드 프로필: OpenCode 플러그인에 필요한 것만(서버·TUI 번들, 내장 스킬, CLI, 스키마, LSP·git-bash MCP) | `script/build-nodes.ts` |
| 재시도 | 엔진 자신의 SQLite 쓰기 실패(`Failed to execute statement`, `database is locked`, `SQLITE_BUSY` — 2026-10-08 긴 하위 작업 2건이 이 오류로 끝남)를 다시 보낼 오류로 분류. nd.3부터 하위 작업·동기 위임·모델 대체가 쓰는 `shouldRetryError`에도 적용(nd.1~2는 기본으로 꺼진 runtime_fallback 훅에만 있어 실제로는 효과가 없었음). 오류 이름이 `UnknownError`(또는 이름 없음)일 때만, 오류에만 맞춰 보고 어시스턴트 답변 본문에는 쓰지 않음(SQLite를 다루는 답변이 '재시도 신호'로 오인되지 않게). 같은 문구가 디스크 가득 참 같은 지속 오류도 덮으므로 횟수는 각 경로의 재시도 한도(`max_fallback_attempts`, 대체 모델 목록)가 막음 | `packages/model-core/src/engine-storage-error.ts` |
| Claude 5 계열 | 엔진(OpenCode 1.18.34)이 Claude 5.x 전부를 1M 문맥·low~max 강도로 보는데, OMO는 sonnet-5-5·fable-5-1을 200K로 계산하고(도구 출력이 약 100K에서 잘림) Sonnet의 xhigh·max를 버렸음(실제 기록에서 강도 없이 실행). 두 판단을 엔진과 맞춤 | `packages/model-core/src/context-limit-resolver.ts`, `model-capability-heuristics.ts` |
| Playwright MCP | 내장 `playwright` 스킬이 `npx @playwright/mcp@latest`(시작마다 최신을 받음, 화면에 창, 디스크에 프로필)로 돌던 것을 `@playwright/mcp@0.0.83 --headless --isolated`로 고정. 엔진은 백그라운드 서비스라 창이 뜰 일이 없어야 하고, 병렬 하위 작업이 한 프로필을 두고 다투지 않음(nd.3: 설정 설명·시험 기대값도 고정값으로) | `packages/skills-loader-core/src/features/builtin-skills/skills/playwright-mcp-skill.ts` |
| 배포 | `script/nd-release.ts`: 커밋 하나를 **항상 새로** 빌드(`--no-build` 없앰 — 옛 빌드가 새 이름으로 나가지 않게) → npm 이름 `oh-my-openagent`로 포장(플랫폼 바이너리·Codex 플러그인 제외, 직접 의존성은 빌드·시험에 쓴 정확한 버전으로 — nd.2는 `^` 범위가 릴리스 날의 zod 4.6.7로 풀렸음) → `~/.local/share/oh-my-openagent-nd/<버전>/`에 스크립트 없이 설치 → 두 진입점 불러오기 확인 → `nd-release.json`(그 아래 단계까지 설치된 버전 목록 포함) | `script/nd-release.ts` |

## 빌드와 배포

```bash
bun install --frozen-lockfile        # 처음 한 번 (이 브랜치의 postinstall은 OpenCode 캐시를 건드리지 않음)
bun test packages/omo-opencode/src/features/nd-usage-observer
# package.json의 version을 5.1.19-nd.<n+1>로 올리고 커밋한 뒤
bun run script/nd-release.ts         # → 마지막 줄의 file:// 항목
```

설치된 릴리스는 고치지 않습니다(같은 버전이 있으면 거부). 엔진에 적용하는 절차 — 격리 엔진 검증(`npm run upgrade:check -- --omo <file:// 항목>`), 설정 백업, 실행 중인 세션이 없을 때 `opencode.json`·`tui.json`의 플러그인 항목 교체, 엔진 재시작 — 은 nd-work-command의 `docs/SETUP.md` §8에 있습니다.

## 업스트림 따라가기

새 업스트림 버전을 통째로 올리지 않습니다. 이 환경에서 쓰는 경로(OpenCode 플랫폼, 위 기능들)의 버그 수정만 골라 `git cherry-pick -x`로 가져오고, 가져온 커밋은 아래 표에 남깁니다. 기준 자체를 옮길 때는(예: v5.1.30) 그 태그에서 새 `nd/custom-<버전>` 브랜치를 만들어 위 변경을 다시 얹고 같은 검증을 거칩니다.

| 업스트림 PR (커밋) | 내용 | 가져온 날 |
|---|---|---|
| #9013 (`8bb682c0d` `6927c3307` `10125ee7f`) | 카테고리 작업이 내장 카테고리의 강도를 물려받아 설정한 model·reasoning과 다르게 나감(quick xhigh→low 등) | 2026-10-13 |
| #9984 (`cf8dd054d` `2fc35ebe7` `379bc1faa` `37eb07c8e` `0af98e594`) | `taskCleanupDelayMs`(이 환경 24시간)보다 먼저 끝난 작업 기록을 30분에 지워, 하위 세션이 지워지지 않고 남음 | 2026-10-13 |
| #7255 (`0f779851f` `f66705a3b` `1228b1106` `8a0e60cc2` `75e064206`) | 글 속 `ulw-plan`·`ulw-execute` 같은 스킬 이름만으로 ultrawork가 켜지고 이후 턴마다 다시 붙음 | 2026-10-13 |
| #7260 (`e09ad60b8` `2f2589b55` `8ecb96d5e`) | Opus 5를 200K로 계산해 도구 출력을 일찍 자름 | 2026-10-13 |
| #10041 (`7083c79fb` `bce861b99`) | 지워진 하위 세션을 만나면 세션 도구 호출 전체가 `[object Object]`로 실패 | 2026-10-13 |

충돌은 `CHANGELOG.md`·`changes.md`·senpi 번들뿐이었고 이 브랜치 쪽을 남겼습니다. 나중 후보(보류): #10001(실시간 모델 정보로 chat.params), #9594(LSP 첫 진단 경쟁), #9731(홈 `.omo` 보호), #7256(하위 세션 제목 앞 카테고리 — 대시보드 표시가 바뀜), #9023(세션 도구 범위 확대).

## 되돌리기

`opencode.json`·`tui.json`의 플러그인 항목을 백업본(또는 `oh-my-openagent@5.1.19`)으로 되돌리고 엔진을 다시 시작합니다. 릴리스 폴더는 지워도 되고 남겨 둬도 됩니다.
