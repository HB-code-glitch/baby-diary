# Firebase 설정 가이드 (BABY DIARY)

아빠 PC(Windows)와 엄마 Mac이 실시간으로 육아 기록을 공유하려면 Firebase를 설정해야 합니다.  
**완전 무료 (Spark 플랜)** — 카드 등록 불필요, 비용 0원.

---

## 1단계: Firebase 프로젝트 만들기

1. [https://console.firebase.google.com](https://console.firebase.google.com) 접속 (Google 계정 필요)
2. **프로젝트 추가** 클릭
3. 프로젝트 이름 입력 (예: `baby-diary-우리가족`)
4. Google 애널리틱스 — **사용 안함** 선택 후 **프로젝트 만들기**
5. 잠시 기다리면 프로젝트가 생성됩니다

---

## 2단계: 이메일/비밀번호 로그인 활성화

1. 왼쪽 메뉴 **Authentication** 클릭
2. **시작하기** 버튼 클릭
3. **로그인 방법** 탭에서 **이메일/비밀번호** 클릭
4. **사용 설정** 토글을 켜고 **저장**

---

## 3단계: Firestore 데이터베이스 만들기

1. 왼쪽 메뉴 **Firestore Database** 클릭
2. **데이터베이스 만들기** 클릭
3. **프로덕션 모드** 선택 (보안 규칙을 직접 관리)
4. 위치(리전) 선택: **asia-northeast3 (서울)** 권장 → **사용 설정**
5. 잠시 기다리면 데이터베이스가 생성됩니다

---

## 4단계: 웹 앱 등록 및 설정값 복사

1. 프로젝트 홈(톱니바퀴 → **프로젝트 설정**)으로 이동
2. **앱 추가** → 웹(`</>`) 아이콘 클릭
3. 앱 닉네임 입력 (예: `baby-diary-desktop`) → **앱 등록**
4. `firebaseConfig` 코드 블록이 나타납니다:

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};
```

5. 이 값 전체를 메모장에 복사해 두세요

---

## 5단계: 앱에 설정 입력 (아빠 PC)

1. BABY DIARY 앱 실행
2. 오른쪽 위 **설정** 아이콘 클릭
3. **Firebase 동기화** 섹션에서 설정값 붙여넣기
4. **저장** 클릭 → 상태가 "연결됨"으로 바뀌면 성공

---

## 6단계: 보안 규칙 배포

### 방법 A: Firebase 콘솔에서 직접 붙여넣기 (권장, 간단)

1. Firestore → **규칙** 탭 클릭
2. 아래 내용을 전체 선택 후 붙여넣기:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // 초대 코드 컬렉션 — 직접 get()만 허용, list 불가
    match /invites/{code} {
      allow get: if request.auth != null;
      allow list: if false;
      allow create: if request.auth != null
        && request.resource.data.code_check == code
        && request.resource.data.familyId is string;
      allow update, delete: if false;
    }

    match /families/{familyId} {
      function isMember() {
        return request.auth != null
          && resource.data.members[request.auth.uid] != null;
      }

      // get: 멤버만 허용 / list: 완전 차단
      allow get: if isMember();
      allow list: if false;

      allow create: if request.auth != null
        && request.resource.data.members[request.auth.uid] != null
        && request.resource.data.inviteCode is string
        && request.resource.data.inviteCode.size() == 6;

      // 멤버 수정 또는 self-join (members 키만 변경하여 본인 추가)
      allow update: if isMember()
        || (
          request.auth != null
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['members'])
          && request.resource.data.members[request.auth.uid] != null
          && resource.data.members.keys().toSet().difference(
               request.resource.data.members.keys().toSet()
             ).size() == 0
        );

      allow delete: if false;

      match /events/{eventDocId} {
        allow read: if request.auth != null
          && get(/databases/$(database)/documents/families/$(familyId)).data.members[request.auth.uid] != null;
        allow create: if request.auth != null
          && get(/databases/$(database)/documents/families/$(familyId)).data.members[request.auth.uid] != null;
        allow update: if false;
        allow delete: if false;
      }
    }
  }
}
```

3. **게시** 클릭

> **보안 참고**: 이전 규칙과 달리 `families`의 `list`가 완전히 차단됩니다. 초대는 `invites/{code}` 컬렉션의 직접 `get()`으로만 가능하므로 가족 목록 열거, 아기 이름 유출, 초대코드 일괄 수집이 불가능합니다. 브루트포스(36^6 ≈ 2.2억 조합)는 Spark 무료 플랜 읽기 할당량(하루 5만 건)으로 실질적으로 차단됩니다.

### 방법 B: Firebase CLI로 배포

```bash
# Firebase CLI 설치 (최초 1회)
npm install -g firebase-tools
firebase login

# 프로젝트 초기화 (baby-diary 폴더에서)
firebase use --add  # 프로젝트 선택

# 규칙 배포
firebase deploy --only firestore:rules
```

---

## 7단계: 가족 연결하기

### 아빠 PC (먼저 시작하는 분)

1. 앱 설정 → **가족 만들기** 클릭
2. 아기 이름, 생일 입력 → **만들기**
3. 6자리 **초대 코드** 확인 (예: `A3B7KP`)
4. 이 코드를 엄마에게 전달

### 엄마 Mac (나중에 참여하는 분)

1. 엄마 Mac에도 BABY DIARY 앱 설치
2. 동일한 Firebase 설정값 입력 (4단계와 동일)
3. 앱 설정 → **코드로 참여** 클릭
4. 아빠에게 받은 6자리 코드 입력
5. 완료! 이제 두 기기가 실시간 동기화됩니다

---

## 자주 묻는 질문

**Q. 인터넷이 없으면 어떻게 되나요?**  
A. 앱은 완전히 동작합니다. 기록이 로컬에 저장되고, 인터넷 연결 시 자동으로 동기화됩니다.

**Q. 비용이 발생하나요?**  
A. Spark 무료 플랜 기준으로 하루 읽기 5만 건, 쓰기 2만 건이 무료입니다. 하루 수십 건 기록하는 육아 앱은 수십 년 동안 무료입니다.

**Q. 데이터가 안전한가요?**  
A. 가족 멤버로 등록된 계정만 데이터에 접근할 수 있습니다. 로컬 파일에도 동시 저장됩니다.

**Q. Firebase 설정을 나중에 변경하면 어떻게 되나요?**  
A. 설정 화면에서 언제든지 변경 가능합니다. 로컬 데이터는 유지됩니다.
