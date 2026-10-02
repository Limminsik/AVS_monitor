// 구글 클라우드 콘솔 › API 및 서비스 › 사용자 인증 정보 › OAuth 클라이언트 ID(웹 애플리케이션)의 ID.
// 폰 앱과 같은 프로젝트(avs-cohort)에서 만든다. 이 값은 비밀이 아니다.
window.AVS_CONFIG = {
  clientId: '992984792848-pmdca9m813i90c07sosos1nke94jkdo8.apps.googleusercontent.com',
  rootFolderName: 'AVS_raw_v2',   // 2.x 앱이 쓰는 드라이브 자리(1.8.1 자료는 AVS_raw)
  fastSeconds: 15,      // 폰 화면·연결 상태를 이만큼마다(바뀐 파일만 받음)
  ackPollSeconds: 20,
  ackWarnMinutes: 2,
  refreshMinutes: 5,
};
