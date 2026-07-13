# 플랫폼 릴리스 서명 운영

공식 플랫폼 패키지는 `v<semver>` 형식의 서명된 태그 또는 Actions의 수동
`signed_package_dry_run` 실행에서만 만든다. 브랜치와 pull request의 일반 빌드는
기존처럼 서명 없이 실행할 수 있다.

## 보호 환경과 secret

아래 값은 GitHub의 보호된 릴리스 환경에 저장하고, 로그나 저장소 파일에
평문으로 기록하지 않는다. 하나라도 없으면 패키징 전에 작업이 실패한다.

### macOS

- `MAC_CSC_LINK`: electron-builder가 읽을 수 있는 Developer ID Application
  PKCS#12 인증서 링크 또는 base64 데이터
- `MAC_CSC_KEY_PASSWORD`: 위 PKCS#12의 암호
- `MAC_CSC_NAME`: 인증서의 완전한 ID. 예:
  `Developer ID Application: HB-code-glitch (TEAMID1234)`
- `MAC_EXPECTED_TEAM_ID`: 인증서와 공증 결과에서 확인할 정확한 Apple Team ID
- `APPLE_API_KEY`: App Store Connect API `.p8` 파일 전체를 base64로 인코딩한 값
- `APPLE_API_KEY_ID`: 위 API 키의 Key ID
- `APPLE_API_ISSUER`: App Store Connect API Issuer ID

### Windows

- `WIN_CSC_LINK`: electron-builder가 읽을 수 있는 Authenticode PFX 인증서 링크
  또는 base64 데이터
- `WIN_CSC_KEY_PASSWORD`: 위 PFX의 암호
- `WIN_EXPECTED_PUBLISHER`: 인증서 Subject와 설치된 `app-update.yml`에서
  일치시킬 정확한 publisher 이름(현재 `HB-code-glitch`)

### GitHub 릴리스

- `RELEASE_TOKEN`: 기존 draft 조회·생성, 불변 asset 업로드, 최종 publish에만
  사용하는 GitHub 토큰. 태그 실행에서만 필요하며 수동 dry-run 작업에는
  주입하지 않는다.

보호 환경은 승인자를 두고 태그 정책을 적용한다. 인증서와 API 키는 만료 전에
교체하며, 교체 뒤에는 먼저 수동 dry-run으로 서명·공증·설치 검증을 확인한다.

## 수동 서명 dry-run

Actions에서 `workflow_dispatch`를 선택하고 `signed_package_dry_run`을 `true`로
설정한다. 이 실행은 실제 서명된 DMG/ZIP/Setup/portable 패키지를 한 번만 만들고,
그 동일 바이트를 Apple Silicon macOS, Intel macOS, Windows 설치 smoke와 manifest
검증까지 전달한다. 내부 artifact 이름에는 run ID와 attempt가 포함되며 보존 기간은
1일이다.

The signed dry run does not create, update, upload, or publish a GitHub release.
따라서 GitHub Release나 태그 상태를 변경하지 않으며, 검증 artifact는 운영 배포로
간주하지 않는다.

## 태그 릴리스 순서

서명된 `v<semver>` 태그 실행은 외부 변경 전에 릴리스 preflight를 통과해야 한다.
그 뒤 Mac과 Windows 패키지를 각각 한 번 만들고, 세 설치 smoke가 모두 같은
artifact 바이트를 통과한 후에만 manifest를 만든다. 업로드 작업은 원본 artifact와
검증 manifest를 다시 받아 해시를 재확인하고, 마지막 단일 작업만 draft를 공개
상태로 전환한다. 인증 정보, 서명, 공증, stapling, publisher, timestamp, PE 아키텍처
중 하나라도 검증되지 않으면 이후 단계는 실행되지 않는다.
