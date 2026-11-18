# 오프라인 npm 의존성 준비

대용량 디스크 검사기는 검증된 로컬 npm tarball로 빈 캐시를 준비할 수 있다. 기준과 후보의 여섯 단계에서 기존 `npm ci --offline --no-audit --no-fund`와 타입 검사, 전체 단위 테스트, 빌드를 실행한다.

## 사용 범위

이미 보유한 npm tarball을 Git 작업 공간 밖의 Unix 비공개 디렉터리에 둔다. 디렉터리는 현재 사용자 소유의 0700, 일반 파일은 같은 사용자 소유의 0600으로 준비한다. tarball 이름은 SHA-512를 소문자 16진수로 바꾼 값에 `.tgz`를 붙인 형태다. 아래 API는 검토된 로컬 호스트 코드에서 사용한다.

```js
import {
  planOfflineNpmDependencies,
  prepareOfflineNpmDependencies,
} from './scripts/offline-npm-runtime.mjs';
import {runLargeDiskIndependentChecks} from './scripts/local-independent-checks.mjs';

const plan = await planOfflineNpmDependencies({diskSnapshot, signal});
// plan.packages의 파일 이름과 주소는 로컬 운영자용이다.
const offlineDependencies = await prepareOfflineNpmDependencies({
  diskSnapshot, tarballRoot, signal,
});
const report = await runLargeDiskIndependentChecks({
  id, stateRoot, privateKey, diskSnapshot, offlineDependencies, imageId, signal,
});
```

기준 전용 `runDiskBaselineStage`와 후보 단계 `runDiskCheckStage`도 같은 선택 인자를 받는다. 준비 결과는 만든 때와 동일한 checks 목적의 디스크 스냅샷 객체에 묶인다. 스냅샷을 다시 열면 같은 로컬 tarball로 새 준비 결과를 만들 수 있다. 보관 전용 자료는 lockfile을 읽기 전에 차단한다.

npm lockfile v2 또는 v3의 최대 1MiB의 루트 npm 파일과 정규 SHA-512 값이 있는 공개 npm 레지스트리 tarball 주소를 지원한다. 루트 npm-shrinkwrap.json, 워크스페이스, 링크, 로컬 및 Git 참조 등 기타 의존성 출처와 지원하지 않는 무결성 형식은 준비 단계에서 실패한다. 의존성 선언과 overrides는 레지스트리 버전 범위 또는 태그를 지원한다. 최대 1,000개 잠금 항목, tarball당 32MiB, 압축 파일 총 256MiB를 적용한다. 모든 잠금 항목의 tarball을 요구하므로 플랫폼별 선택 의존성도 준비 대상이다. Git이나 npm에 패키지 목록을 조회하는 과정은 없고 tarball 수집은 이 API의 외부에서 이뤄진다.

## 무결성과 실행

호스트는 lockfile의 Git/SHA-256 검증을 수행하고 tarball을 SHA-512와 대조한다. 각 검사에 전달할 때 파일 권한·크기·해시를 다시 확인한다. 같은 SHA-512의 tarball은 한 번씩 전달하며, 배치당 최대 8개를 로컬 `npm cache add --offline --ignore-scripts`로 넣는다. 이 명령은 프로젝트 외부의 격리 디렉터리에서 실행한다. 원래 `npm ci`는 프로젝트 디렉터리에서 실행하고 설치 스크립트도 이 단계에서 실행한다. 컨테이너의 쓰기 공간, 메모리, 출력, 종료 시간 제한을 적용한다.

비공개 보고서는 lockfile 지문, tarball 목록과 바이트 크기의 지문, 개수와 총 바이트만 추가한다. 저장된 보고서의 의존성 정보는 배타적으로 생성한 claim과 같아야 한다. 게시 승인과 모델 리뷰는 계속 별도 단계다.

두 합성 tarball을 쓰는 Docker 검증에서 캐시 없이는 설치가 실패했고 캐시를 채운 뒤에는 여섯 검사 단계가 설치한 모듈을 실제 사용했다. 설치 스크립트는 `npm ci`에서 실행됐고, 입력 tarball은 컨테이너에서 읽기 전용이었다. 실제 게임에 필요한 tarball 목록, 현재 지원 범위 적합성, 실행 입력 정책 및 게임의 검사 결과는 별도 검증이 필요하다.
