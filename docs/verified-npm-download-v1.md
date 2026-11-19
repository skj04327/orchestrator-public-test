# 검증된 npm 패키지 다운로드

비공개 실행용 스냅샷의 잠금 파일에서 공개 npm 레지스트리 주소와 SHA-512를 도출한다. 신뢰된 로컬 호스트에서 검증한 스냅샷 객체와 Git 밖의 비공개 패키지 디렉터리를 전달한다.

```js
import {downloadOfflineNpmDependencies} from './scripts/offline-npm-download.mjs';
import {runDiskBaselineStage} from './scripts/disk-baseline-check.mjs';

const {dependencies} = await downloadOfflineNpmDependencies({diskSnapshot, tarballRoot, signal});
for (const stage of ['typecheck', 'unit-test', 'build']) {
  const result = await runDiskBaselineStage({
    diskSnapshot, offlineDependencies: dependencies, imageId, stage, signal,
  });
  if (result.status !== 'passed' && result.failureKind !== 'check_failed') break;
}
```

필요한 패키지만 고정 npm HTTPS 주소에서 받는다. 리다이렉트와 사용자 curl 설정을 거부한다. 환경에 이미 지정된 프록시·인증서 설정은 사용할 수 있고, GitHub와 AI 자격 증명은 내려보내지 않는다. HTTP 상태 외 응답 진단과 URL을 로그로 전달하지 않는다. GitHub Actions에서는 이 API를 차단한다.

파일은 잠금된 SHA-512와 맞을 때만 비공개 디렉터리에 확정한다. 재호출은 기존 파일의 권한과 SHA-512를 다시 확인한 뒤 재사용한다. 실패한 임시 파일은 정리하며 같은 이름의 파일을 덮어쓰지 않는다. 같은 디렉터리에 동시에 다운로드하면 먼저 시작한 작업만 진행한다. 강제 종료로 잠금 디렉터리가 남으면, 실행 중인 다운로드가 없는 것을 확인한 뒤 해당 잠금만 정리하거나 새 패키지 디렉터리를 사용한다. 오프라인 검사 준비와 각 Docker 전송 때 무결성을 다시 확인한다.

파일당 32MiB, 의존성 집합 256MiB, 요청당 25초, 획득 전체 10분 한도를 적용한다. 일시적 연결 오류, HTTP 429와 5xx는 파일당 한 번 재시도하고 전체 재시도는 12회까지 허용한다. 검사기는 기존의 네트워크 차단 상태에서 npm 설치 스크립트와 검사를 실행한다.

보관 전용 스냅샷은 lockfile을 읽기 전에 차단한다. 보고서는 기존 확정 커밋과 설치한 의존성의 지문에 연결한다. 제외한 설정이 있는 게임 스냅샷의 검사 결과는 `github-main-projected`로 기록한다.

## 검사 실패 진단

호스트에서 `runDiskBaselineStage`를 호출할 때 비공개 `diagnosticsRoot`를 지정하면 제한된 컨테이너 출력이 권한 0600인 파일에 저장된다. 함수는 파일 식별자만 반환한다. 실제 게임 검사에서도 원시 출력은 비공개로 유지한다.

네이티브 도구를 쓰는 npm 설치를 위해 검증된 오프라인 의존성을 연결한 작업에서만 격리 작업 공간 `/work`에 실행 권한을 명시한다. `nosuid`와 `nodev`, 네트워크 차단, 읽기 전용 루트와 입력, nonroot 실행, 권한 및 자원 제한을 적용한다. 합성 Docker 회귀는 작은 네이티브 파일을 작업 공간에서 실행하고, 오프라인 설치 실패 진단의 파일 권한과 출력 한도를 검증한다.

기준 코드의 전체 단위 테스트는 호스트 호출에서 최대 15분을 명시할 수 있다. 기본값, 타입 검사, 빌드와 입력 전송의 한도는 7분이다. 기준과 후보를 함께 검사하는 경우에는 [독립 검증의 단위 테스트 한도](large-disk-validation-v1.md#여섯-단계와-실패)를 사용한다. 테스트 명령과 선택 범위는 동일하다.
