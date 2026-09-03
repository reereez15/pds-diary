# 플랜두씨 다이어리 2 (과제 7 — 인증 붙이기)

계획(Plan) → 실제로 한 일(Do) → 돌아보기(See)가 하나로 이어지는 다이어리 앱.
과제 6에 가입·로그인·로그아웃을 붙여, 로그인한 사람만 자신의 계획·기록을 볼 수 있습니다.

## 준비물
MySQL 인스턴스(Aiven for MySQL, 과제 6과 동일)가 그대로 필요합니다. 새 DB는 만들지 않고,
기존 DB에 `users`, `refresh_tokens` 테이블과 기존 테이블의 `user_id` 컬럼이 자동으로 추가됩니다.

## 실행 방법
```
npm install
cp .env.example .env   # 접속 정보 채우기 (Aiven Service URI를 MYSQL_URL에)
                        # + JWT_ACCESS_SECRET / JWT_REFRESH_SECRET 도 임의의 긴 문자열로 채우기
npm start
```
`http://localhost:3000/login.html` 에서 회원가입 후 로그인하면 `index.html`(다이어리 화면)로 이동합니다.
서버 시작 시 필요한 테이블/컬럼을 자동으로 만듭니다(수동 마이그레이션 불필요).

## 인증 구현 설명

① **무엇으로 붙였나** — 직접 구현(라이브러리 조합): `bcrypt`(비밀번호 해싱) + `jsonwebtoken`(JWT) + `cookie-parser`.
인증 흐름(라우트, 미들웨어, DB 스키마)은 전부 이 저장소 코드(`auth.js`)에 있어 동작을 직접 설명할 수 있습니다.

② **왜 그걸 골랐나** — 이전에 JWT를 다뤄본 적이 있어 구현 실수 위험이 낮고, Express + Aiven MySQL 조합에서
별도 세션 저장소 없이 액세스 토큰을 무상태(stateless)로 검증할 수 있습니다. Render 무료 플랜은 재시작/슬립이
잦은데, 세션을 서버 메모리에 두면 재시작 시 로그인이 풀리는 문제를 JWT는 피할 수 있습니다.

③ **어떻게 고쳤나** — 액세스 토큰(짧은 만료, 응답 바디로 전달·클라이언트는 sessionStorage에 보관)과
리프레시 토큰(긴 만료, httpOnly 쿠키로 전달 + 서버 DB `refresh_tokens`에 화이트리스트 저장) 이중 구조로
구현. 로그아웃 시 DB에서 리프레시 토큰 레코드를 삭제해 즉시 무효화합니다.

④ **안 열리는 것을 확인한 기록** — `AUTH_EVIDENCE.md`(직접 작성 필요, 아래 "증거 만드는 법" 참고)에
요청/응답 캡처를 정리합니다.

⑤ **AI와 나** — AI에게 맡긴 일 / 내가 직접 판단한 일 / AI 말을 따르지 않은 일을 직접 정리해 넣습니다.

⑥ **아직 못 막은 것** — 예: 액세스 토큰 자체는 만료 전까지(최대 15분) 로그아웃 후에도 이론상 유효함.
만료 시간을 짧게 잡아 노출 구간을 최소화했으나 완전한 즉시 무효화는 아님.

## 증거 만드는 법 (제출용, 비밀번호·토큰 원문은 절대 적지 않기)

1. **카드2 (비밀번호 저장)**: Aiven 콘솔에서 `SELECT id, email, password_hash FROM users LIMIT 1;` 실행 →
   `password_hash` 값이 `$2b$...`로 시작하는 해시인지(평문이 아닌지) 캡처.
2. **카드3 (로그인 유지/끊김)**: 로그인 상태에서 `GET /api/plans` 요청 성공 응답과, `POST /api/auth/logout` 후
   같은 요청을 다시 보냈을 때의 401 응답을 나란히 캡처. 토큰 값 자체는 `eyJhb...생략` 식으로 가림.
3. **카드4 (남의 자료 차단)**: 계정 A, B를 만들어 각각 계획을 1개 이상 만든 뒤, A로 로그인한 상태에서 B의
   `plan id`를 직접 넣어 `GET/PUT/DELETE /api/plans/:id` 요청 → 404 응답 캡처. 반대 방향도 동일하게.
4. **카드5 (엔드포인트 잠금 5개 이상)**: 로그인하지 않은 채(Authorization 헤더 없이)
   `POST /api/plans`, `POST /api/tasks`, `POST /api/tasks/:id/complete`, `DELETE /api/plans/:id`,
   `POST /api/reviews` 등 5개 이상에 직접 요청 → 전부 401 응답 캡처.

## 배포
- 앱 서버: Render Web Service (Node) — 기존과 동일하게 GitHub 연동 자동 배포
- DB: Aiven for MySQL — 기존과 동일한 인스턴스 재사용 (`MYSQL_URL`)
- Render 환경변수에 `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV=production` 추가 등록
  (`NODE_ENV=production`이어야 리프레시 쿠키의 `secure` 옵션이 켜져 HTTPS에서만 쿠키가 오갑니다)

## 짧은 확인 방법
1. 어디로 가나요 — 배포된 주소를 새 시크릿창에서 엽니다. (예: `https://.../`)
2. 세 단계 안에 무엇을 하나요 — 자동으로 로그인 화면으로 이동 → 회원가입 후 로그인 → 계획을 하나 만들어 봅니다.
3. 무엇이 되면 통과인가요 — 로그인 없이 같은 주소를 열면 다시 로그인 화면이 뜨고, 로그인하면 방금 만든
   내 계획만 보입니다.
4. 안 될 때는 무엇이 보이나요 — 로그인 실패 시 "이메일 또는 비밀번호가 올바르지 않습니다" 문구가 뜨고,
   세션이 끊긴 상태에서 데이터 요청을 하면 자동으로 로그인 화면으로 돌아갑니다.
