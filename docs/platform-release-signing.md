# 플랫폼 릴리스 서명 운영

공식 플랫폼 패키지는 `v<semver>` 형식의 서명된 태그 또는 Actions의 수동
`signed_package_dry_run` 실행에서만 만든다. 브랜치와 pull request의 일반 빌드는
기존처럼 서명 없이 실행할 수 있다.

## 보호 환경과 secret

두 GitHub Environment를 아래의 정확한 이름으로 만든다. secret은 로그나 저장소
파일에 평문으로 기록하지 않으며, 하나라도 없으면 패키징 전에 작업이 실패한다.

### `platform-release-signing`

Apple/Windows 인증서와 공증 secret만 저장한다. 보호 규칙에서
`Required reviewers`와 `Prevent self-review`를 켜고, `Selected branches and tags`를
선택해 `master` 브랜치와 `v*` 태그만 허용한다. 수동 서명 dry-run은 `master`를
ref로 선택한다. 이 환경에는 `RELEASE_TOKEN`을 저장하지 않는다.

### `platform-release-publish`

`RELEASE_TOKEN`만 저장한다. `Required reviewers`, `Prevent self-review`,
`Selected branches and tags`를 켜고 `v*` 태그만 허용한다. 브랜치는 허용하지
않는다. 이 환경에는 인증서나 공증 secret을 저장하지 않는다.

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
- `WIN_EXPECTED_PUBLISHER`: 인증서의 전체 Subject DN. 예:
  `CN=HB-code-glitch, O=Example Company, C=KR`. bare CN(`HB-code-glitch`)만 넣지
  않는다. PowerShell/X509의 `SignerCertificate.Subject`가 출력한 문자열을 그대로
  복사하며, 공백·escape·quote·RDN 구조·속성 순서를 정규화하거나 재정렬하지 않는다.
  Authenticode 검사, electron-builder의 `publisherName`, 설치된
  `app-update.yml.publisherName`은 모두 이 문자열과 ordinal exact equality로 비교한다.
  electron-builder 26은 updater metadata에 이 값을 정확히 하나의 문자열 배열로
  기록한다. 검증기는 이 canonical 배열만 허용하며 단일 문자열도 거부한다. 빈 배열,
  비문자 값, 혼합 배열, 중복·대체 publisher가 하나라도 있으면 모두 실패한다.
- `WIN_EXPECTED_CERT_SHA256`: 같은 서명 인증서의 SHA-256 thumbprint. separator 없는
  정확히 64자리 16진수로 저장한다. 16진수 대소문자만 동등하게 취급하며 Subject가
  같더라도 이 값이 다른 인증서는 거부한다.

Windows 인증서를 `$certificate`에 불러온 뒤 아래 두 출력값을 각각 secret에
복사한다. 첫 줄은 문자열을 손대지 않고 `WIN_EXPECTED_PUBLISHER`에, 둘째 줄은
`WIN_EXPECTED_CERT_SHA256`에 넣는다.

```powershell
$certificate.Subject
$certificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)
```

Setup, portable, unpacked main executable, `elevate.exe`, 설치 smoke의 Setup/main은
전체 Subject DN과 SHA-256 thumbprint가 모두 일치해야 통과한다.

### GitHub 릴리스

- `RELEASE_TOKEN`: 기존 draft 조회·생성, 불변 asset 업로드, 최종 publish에만
  사용하는 GitHub 토큰. 태그 실행에서만 필요하며 수동 dry-run 작업에는
  주입하지 않는다.

두 보호 환경 모두 관리자 우회를 끄는 것을 권장한다. 인증서와 API 키는 만료 전에
교체하며, 교체 뒤에는 먼저 `master`의 수동 dry-run으로 서명·공증·설치 검증을
확인한다.

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
