/**
 * Reelio — 프론트엔드 ↔ FastAPI 백엔드 연동 스크립트
 * 지원 플랫폼: TikTok, Douyin(더우인), 샤오홍슈(RED) — 입력 링크 주소로 자동 판별됩니다.
 *
 * 담당 기능:
 *   1. 링크 입력 → 폼 제출 → /api/extract 요청 → 결과 렌더링
 *   2. 상단 탭 버튼 활성 상태 전환 (형식 선택 UI, 현재는 시각적 상태만 담당)
 *   3. FAQ 아코디언 열고 닫기
 *
 * 참고: 현재 백엔드(/api/extract)는 워터마크 없는 MP4 URL만 반환합니다.
 *       MP3 추출, 워터마크 포함 원본 URL은 백엔드에 아직 없는 필드라
 *       응답에 해당 값이 없으면 버튼을 비활성 상태로 유지합니다.
 *       추후 백엔드에서 mp3_url / watermark_url 필드를 추가하면
 *       자동으로 활성화되도록 만들어 두었습니다.
 */

const API_BASE = "http://localhost:8000";

// ── 다운로드 폼 관련 요소 ──
const form = document.getElementById("downloadForm");
const urlInput = document.getElementById("videoUrl");
const submitBtn = document.getElementById("submitBtn");
const loadingBlock = document.getElementById("loading");
const resultSection = document.getElementById("resultSection");
const errorMsg = document.getElementById("errorMsg");

const videoCover = document.getElementById("videoCover");
const resultPlatformTag = document.getElementById("resultPlatformTag");
const videoTitle = document.getElementById("videoTitle");
const videoAuthor = document.getElementById("videoAuthor");
const videoDuration = document.getElementById("videoDuration");
const downloadButtonList = document.getElementById("downloadButtonList");
const moreDownloadsBtn = document.getElementById("moreDownloadsBtn");
const xhsWatermarkNote = document.getElementById("xhsWatermarkNote");
const langSelect = document.getElementById("langSelect");
const formatNote = document.getElementById("formatNote");
const heroTitle = document.getElementById("heroTitle");

/**
 * 틱톡/더우인/샤오홍슈 앱의 '링크 복사' 기능은 링크만 딱 복사되지 않고,
 * "91【开箱🎁...】 ... http://xhslink.com/xxxx 복사해서 앱에서 열어보세요!" 처럼
 * 제목/설명 문구와 링크가 뒤섞인 텍스트가 함께 복사되는 경우가 많습니다.
 * 이 함수는 그 안에서 실제 http(s):// 링크만 뽑아냅니다. 못 찾으면 null.
 */
function extractUrl(rawText) {
  if (!rawText) return null;
  const match = rawText.match(/https?:\/\/[^\s"'<>，。、]+/i);
  if (!match) return null;
  // 링크 끝에 붙은 문장부호(마침표, 쉼표, 괄호 등)를 제거
  return match[0].replace(/[.,，。、!?！？)\]}"'”’]+$/, "");
}

/**
 * 붙여넣는 즉시 텍스트 안의 링크만 추출해서 입력창을 깔끔하게 정리합니다.
 * (링크를 못 찾으면 사용자가 붙여넣은 원본 그대로 둡니다 — 직접 지우고 다시 넣을 수 있도록)
 */
urlInput.addEventListener("paste", () => {
  setTimeout(() => {
    const extracted = extractUrl(urlInput.value);
    if (extracted && extracted !== urlInput.value.trim()) {
      urlInput.value = extracted;
    }
  }, 0);
});

// 백엔드가 내려주는 platform 값 → 화면에 보여줄 라벨 매핑
const PLATFORM_LABELS = {
  tiktok: "TikTok",
  douyin: "Douyin",
  xiaohongshu: "샤오홍슈",
};

function resetState() {
  errorMsg.classList.add("hidden");
  errorMsg.textContent = "";
  resultSection.classList.add("hidden");
  downloadButtonList.innerHTML = "";
  xhsWatermarkNote.classList.add("hidden");
  videoCover.pause();
  videoCover.removeAttribute("src");
  videoCover.load();
}

function showError(message) {
  errorMsg.textContent = message;
  errorMsg.classList.remove("hidden");
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  loadingBlock.classList.toggle("hidden", !isLoading);
}

/**
 * 초 단위 재생시간을 "0:57" 같은 표시 형식으로 바꿉니다.
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * "다운로드 <라벨>" 형태의 버튼 하나를 만들어 반환합니다.
 */
/**
 * 파일을 fetch로 직접 받아 blob으로 만든 뒤 강제로 다운로드시킵니다.
 * CDN이 교차 출처(CORS) 요청을 허용하는 경우에만 성공하며, 성공하면 새 탭이
 * 뜨지 않고 바로 다운로드됩니다. 막혀 있으면 false를 반환해서 호출부가
 * 예전 방식(새 탭에서 열기)으로 대체할 수 있게 합니다.
 */
async function triggerBlobDownload(url, filename) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 영상 용량이 클 수 있어 60초로 넉넉하게
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return false;
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    return true;
  } catch (err) {
    return false; // CORS 차단, 타임아웃 등으로 실패한 경우
  } finally {
    clearTimeout(timeoutId);
  }
}

function makeDownloadButton(label, url, extraClass) {
  const a = document.createElement("a");
  a.href = url; // 자바스크립트가 막힌 환경 등을 위한 기본 폴백
  a.rel = "noopener noreferrer";
  a.className = "dl-btn" + (extraClass ? ` ${extraClass}` : "");
  a.textContent = `⬇ ${label}`;

  a.addEventListener("click", async (e) => {
    e.preventDefault();
    const original = a.textContent;
    a.textContent = "⏳ 다운로드 중...";
    a.style.pointerEvents = "none";

    const ext = extraClass === "mp3" ? "mp3" : "mp4";
    const filename = `downclip_${Date.now()}.${ext}`;
    const success = await triggerBlobDownload(url, filename);

    a.textContent = original;
    a.style.pointerEvents = "";

    if (!success) {
      // 직접 다운로드가 막힌 CDN → 예전처럼 새 탭에서 열어서 사용자가 저장하게 함
      window.open(url, "_blank", "noopener,noreferrer");
    }
  });

  return a;
}

function renderResult(data) {
  resultPlatformTag.textContent = PLATFORM_LABELS[data.platform] || data.platform || "알 수 없음";
  videoTitle.textContent = data.title || "제목 없음";
  videoAuthor.textContent = data.author ? `@${data.author}` : "게시자 정보 없음";

  const durationText = formatDuration(data.duration);
  if (durationText) {
    videoDuration.textContent = durationText;
    videoDuration.classList.remove("hidden");
  } else {
    videoDuration.classList.add("hidden");
  }

  // 비디오 요소로 미리보기: poster는 커버 이미지, src는 대표 화질 영상
  if (data.video_url) {
    if (data.cover_url) videoCover.poster = data.cover_url;
    videoCover.src = data.video_url;
    videoCover.classList.remove("hidden");
    // 자동재생이 브라우저 정책으로 막히는 경우가 있어 명시적으로 재시도
    videoCover.play().catch(() => {
      /* 자동재생이 차단되면 그냥 포스터 이미지로 보여짐 (사용자가 클릭하면 재생) */
    });
  } else if (data.cover_url) {
    videoCover.poster = data.cover_url;
    videoCover.removeAttribute("src");
    videoCover.classList.remove("hidden");
  } else {
    videoCover.classList.add("hidden");
  }

  // 같은 라벨이 중복으로 올 수 있어(백업 서버용 등) label 기준으로 중복 제거
  const rawQualities = Array.isArray(data.qualities) ? data.qualities : [];
  const seenLabels = new Set();
  const qualities = rawQualities.filter((q) => {
    if (seenLabels.has(q.label)) return false;
    seenLabels.add(q.label);
    return true;
  });

  downloadButtonList.innerHTML = "";

  if (qualities.length > 0) {
    qualities
      .slice()
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      .forEach((q) => {
        downloadButtonList.appendChild(makeDownloadButton(q.label || "MP4", q.url));
      });
  } else {
    // 화질 목록이 없으면 대표 video_url 하나만 버튼으로
    downloadButtonList.appendChild(makeDownloadButton("MP4", data.video_url));
  }

  // 배경음악 등 별도 오디오 트랙이 실제로 있을 때만 MP3 버튼 추가
  if (data.audio_url) {
    downloadButtonList.appendChild(makeDownloadButton("MP3", data.audio_url, "mp3"));
  }

  // 샤오홍슈는 공유 스트림 자체에 작은 로고가 포함된 경우가 있어 안내 문구를 보여줌
  xhsWatermarkNote.classList.toggle("hidden", data.platform !== "xiaohongshu");

  resultSection.classList.remove("hidden");
}

/**
 * "더 많은 다운로드" 바 클릭 시 처음 화면(입력 전 상태)으로 되돌립니다.
 */
moreDownloadsBtn.addEventListener("click", () => {
  resetState();
  urlInput.value = "";
  urlInput.focus();
  urlInput.closest(".search-form").scrollIntoView({ behavior: "smooth", block: "center" });
});

async function handleSubmit(event) {
  event.preventDefault();

  const raw = urlInput.value.trim();
  resetState();

  if (!raw) {
    showError("링크를 먼저 붙여넣어 주세요.");
    return;
  }

  // 붙여넣기 이벤트에서 놓쳤을 경우를 대비한 2차 안전장치
  const url = extractUrl(raw) || raw;

  if (!/^https?:\/\//i.test(url)) {
    showError(
      "입력하신 내용에서 링크(https://...)를 찾지 못했어요. 앱의 공유 버튼에서 '링크 복사'를 눌러 다시 붙여넣어 주세요."
    );
    return;
  }

  // 정리된 URL을 입력창에도 반영해서 사용자가 무엇이 전송되는지 알 수 있게 함
  if (url !== raw) urlInput.value = url;

  setLoading(true);

  try {
    // 서버가 응답 없이 멈추는 경우를 대비해 30초 타임아웃을 둡니다.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      response = await fetch(
        `${API_BASE}/api/extract?url=${encodeURIComponent(url)}`,
        { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || "영상 정보를 가져오지 못했어요.");
    }

    renderResult(data);
  } catch (err) {
    if (err.name === "AbortError") {
      showError("서버 응답이 너무 오래 걸려요(30초 초과). 잠시 후 다시 시도해주세요.");
    } else {
      showError(err.message || "서버에 연결할 수 없어요. 백엔드가 실행 중인지 확인해주세요.");
    }
  } finally {
    setLoading(false);
  }
}

form.addEventListener("submit", handleSubmit);

// ── 붙여넣기(📋) 버튼: 클립보드 내용을 자동으로 입력창에 채워줌 ──
const pasteBtn = document.getElementById("pasteBtn");
if (pasteBtn) {
  pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const extracted = extractUrl(text) || text.trim();
        urlInput.value = extracted;
        urlInput.focus();
      }
    } catch (err) {
      // 클립보드 접근 권한이 없거나(브라우저 정책) http:// 환경 등에서는 실패할 수 있음
      showError("클립보드에 접근할 수 없어요. 입력창에 직접 붙여넣어 주세요 (길게 눌러 붙여넣기).");
    }
  });
}

// ── 형식/플랫폼 탭 · 네비게이션 클릭 처리 ──
// 실제로는 링크 하나로 모든 플랫폼을 자동 인식하기 때문에, 이 버튼들은
// '모드를 바꾸는' 스위치가 아니라 입력창으로 안내하고 상황에 맞는 큰 제목·안내문구·
// placeholder를 보여주는 역할을 합니다. 4개 언어(한/영/일/중) 모두 대응합니다.

const TAB_CONTENT = {
  video: {
    ko: { title: "틱톡 워터마크 제거 다운로더", note: "틱톡 영상 링크를 붙여넣으면 워터마크 없는 MP4로 바로 받을 수 있어요.", placeholder: "틱톡 공유 링크를 붙여넣으세요 (예: https://vt.tiktok.com/...)" },
    en: { title: "TikTok Watermark Remover", note: "Paste a TikTok video link to get an MP4 with no watermark.", placeholder: "Paste a TikTok share link (e.g. https://vt.tiktok.com/...)" },
    ja: { title: "TikTok 透かし除去ダウンローダー", note: "TikTokの動画リンクを貼り付けると、透かしなしのMP4をすぐに取得できます。", placeholder: "TikTokの共有リンクを貼り付けてください（例: https://vt.tiktok.com/...）" },
    zh: { title: "TikTok 去水印下载器", note: "粘贴 TikTok 视频链接，即可获取无水印 MP4。", placeholder: "请粘贴 TikTok 分享链接（例如：https://vt.tiktok.com/...）" },
    vi: { title: "Công cụ xóa watermark TikTok", note: "Dán link video TikTok để lấy MP4 không watermark ngay.", placeholder: "Dán link chia sẻ TikTok (vd: https://vt.tiktok.com/...)" },
    th: { title: "เครื่องมือลบลายน้ำ TikTok", note: "วางลิงก์วิดีโอ TikTok เพื่อรับไฟล์ MP4 แบบไม่มีลายน้ำทันที", placeholder: "วางลิงก์แชร์ TikTok (เช่น https://vt.tiktok.com/...)" },
    id: { title: "Penghapus Watermark TikTok", note: "Tempel link video TikTok untuk langsung mendapatkan MP4 tanpa watermark.", placeholder: "Tempel link TikTok (contoh: https://vt.tiktok.com/...)" },
    km: { title: "កម្មវិធីលុបស្លាកទឹក TikTok", note: "បិទភ្ជាប់តំណភ្ជាប់វីដេអូ TikTok ដើម្បីទទួលបាន MP4 ដោយគ្មានស្លាកទឹកភ្លាមៗ។", placeholder: "បិទភ្ជាប់តំណភ្ជាប់ចែករំលែក TikTok (ឧទាហរណ៍៖ https://vt.tiktok.com/...)" },
  },
  mp3: {
    ko: { title: "틱톡 MP3 추출 다운로더", note: "영상에 별도 음원이 있는 경우, MP4와 함께 MP3 다운로드 버튼도 제공돼요.", placeholder: "틱톡 공유 링크를 붙여넣으세요 (예: https://vt.tiktok.com/...)" },
    en: { title: "TikTok MP3 Extractor", note: "Paste a link and you'll get an MP3 download option alongside the MP4.", placeholder: "Paste a TikTok share link (e.g. https://vt.tiktok.com/...)" },
    ja: { title: "TikTok MP3 抽出ダウンローダー", note: "リンクを貼り付けると、MP4と一緒にMP3ダウンロードも選べます。", placeholder: "TikTokの共有リンクを貼り付けてください（例: https://vt.tiktok.com/...）" },
    zh: { title: "TikTok MP3 提取下载器", note: "粘贴链接后，会同时提供 MP4 和 MP3 下载选项。", placeholder: "请粘贴 TikTok 分享链接（例如：https://vt.tiktok.com/...）" },
    vi: { title: "Trích xuất MP3 TikTok", note: "Dán link, bạn sẽ nhận được cả tùy chọn tải MP3 cùng với MP4.", placeholder: "Dán link chia sẻ TikTok (vd: https://vt.tiktok.com/...)" },
    th: { title: "แยกเสียง MP3 จาก TikTok", note: "วางลิงก์แล้วคุณจะได้ตัวเลือกดาวน์โหลด MP3 พร้อมกับ MP4", placeholder: "วางลิงก์แชร์ TikTok (เช่น https://vt.tiktok.com/...)" },
    id: { title: "Ekstraksi MP3 TikTok", note: "Tempel link dan Anda akan mendapatkan opsi unduh MP3 selain MP4.", placeholder: "Tempel link TikTok (contoh: https://vt.tiktok.com/...)" },
    km: { title: "ស្រង់ចេញ MP3 TikTok", note: "បិទភ្ជាប់តំណភ្ជាប់ ហើយអ្នកនឹងទទួលបានជម្រើសទាញយក MP3 រួមជាមួយ MP4។", placeholder: "បិទភ្ជាប់តំណភ្ជាប់ TikTok (ឧទាហរណ៍៖ https://vt.tiktok.com/...)" },
  },
  photo: {
    ko: { title: "틱톡 사진(슬라이드) 다운로더", note: "사진(슬라이드) 게시물 지원은 현재 준비 중이에요. 영상 링크로 먼저 이용해주세요.", placeholder: "틱톡 공유 링크를 붙여넣으세요 (예: https://vt.tiktok.com/...)" },
    en: { title: "TikTok Photo Downloader", note: "Photo/slideshow support is coming soon. Please try a video link for now.", placeholder: "Paste a TikTok share link (e.g. https://vt.tiktok.com/...)" },
    ja: { title: "TikTok 写真ダウンローダー", note: "写真（スライド）投稿の対応は準備中です。まずは動画リンクをお試しください。", placeholder: "TikTokの共有リンクを貼り付けてください（例: https://vt.tiktok.com/...）" },
    zh: { title: "TikTok 图片下载器", note: "图片(幻灯片)支持功能正在开发中，请先使用视频链接。", placeholder: "请粘贴 TikTok 分享链接（例如：https://vt.tiktok.com/...）" },
    vi: { title: "Tải ảnh TikTok", note: "Hỗ trợ ảnh (slideshow) sắp ra mắt. Hãy thử với link video trước.", placeholder: "Dán link chia sẻ TikTok (vd: https://vt.tiktok.com/...)" },
    th: { title: "ดาวน์โหลดรูปภาพ TikTok", note: "การรองรับรูปภาพ (สไลด์โชว์) กำลังจะมาเร็วๆ นี้ กรุณาลองใช้ลิงก์วิดีโอก่อน", placeholder: "วางลิงก์แชร์ TikTok (เช่น https://vt.tiktok.com/...)" },
    id: { title: "Pengunduh Foto TikTok", note: "Dukungan foto (slideshow) akan segera hadir. Coba gunakan link video dulu.", placeholder: "Tempel link TikTok (contoh: https://vt.tiktok.com/...)" },
    km: { title: "កម្មវិធីទាញយករូបភាព TikTok", note: "ការគាំទ្ររូបភាព (បញ្ជីរូបភាព) នឹងមកដល់ឆាប់ៗនេះ។ សូមសាកល្បងជាមួយតំណភ្ជាប់វីដេអូជាមុនសិន។", placeholder: "បិទភ្ជាប់តំណភ្ជាប់ TikTok (ឧទាហរណ៍៖ https://vt.tiktok.com/...)" },
  },
  douyin: {
    ko: { title: "더우인 워터마크 제거 다운로더", note: "더우인 링크도 같은 입력창에 붙여넣으면 자동으로 인식돼요.", placeholder: "더우인 공유 링크를 붙여넣으세요 (예: https://v.douyin.com/...)" },
    en: { title: "Douyin Watermark Remover", note: "Douyin links work in the same input box — they're detected automatically.", placeholder: "Paste a Douyin share link (e.g. https://v.douyin.com/...)" },
    ja: { title: "Douyin 透かし除去ダウンローダー", note: "Douyinのリンクも同じ入力欄で自動的に認識されます。", placeholder: "Douyinの共有リンクを貼り付けてください（例: https://v.douyin.com/...）" },
    zh: { title: "抖音去水印下载器", note: "抖音链接同样可以粘贴到这个输入框，会自动识别。", placeholder: "请粘贴抖音分享链接（例如：https://v.douyin.com/...）" },
    vi: { title: "Công cụ xóa watermark Douyin", note: "Link Douyin cũng dùng chung ô nhập này — được nhận diện tự động.", placeholder: "Dán link chia sẻ Douyin (vd: https://v.douyin.com/...)" },
    th: { title: "เครื่องมือลบลายน้ำ Douyin", note: "ลิงก์ Douyin ก็ใช้ช่องกรอกเดียวกันนี้ได้ — ระบบจะตรวจจับให้อัตโนมัติ", placeholder: "วางลิงก์แชร์ Douyin (เช่น https://v.douyin.com/...)" },
    id: { title: "Penghapus Watermark Douyin", note: "Link Douyin juga bisa ditempel di kotak yang sama — akan terdeteksi otomatis.", placeholder: "Tempel link Douyin (contoh: https://v.douyin.com/...)" },
    km: { title: "កម្មវិធីលុបស្លាកទឹក Douyin", note: "តំណភ្ជាប់ Douyin ក៏ប្រើប្រអប់បញ្ចូលដូចគ្នានេះដែរ — នឹងត្រូវបានរកឃើញដោយស្វ័យប្រវត្តិ។", placeholder: "បិទភ្ជាប់តំណភ្ជាប់ Douyin (ឧទាហរណ៍៖ https://v.douyin.com/...)" },
  },
  xiaohongshu: {
    ko: { title: "샤오홍슈 워터마크 제거 다운로더", note: "샤오홍슈 링크도 같은 입력창에 붙여넣으면 자동으로 인식돼요.", placeholder: "샤오홍슈 공유 링크를 붙여넣으세요 (예: https://xhslink.com/...)" },
    en: { title: "Xiaohongshu Watermark Remover", note: "Xiaohongshu links work in the same input box — they're detected automatically.", placeholder: "Paste a Xiaohongshu share link (e.g. https://xhslink.com/...)" },
    ja: { title: "RED(小紅書) 透かし除去ダウンローダー", note: "小紅書のリンクも同じ入力欄で自動的に認識されます。", placeholder: "小紅書の共有リンクを貼り付けてください（例: https://xhslink.com/...）" },
    zh: { title: "小红书去水印下载器", note: "小红书链接同样可以粘贴到这个输入框，会自动识别。", placeholder: "请粘贴小红书分享链接（例如：https://xhslink.com/...）" },
    vi: { title: "Công cụ xóa watermark Xiaohongshu", note: "Link Xiaohongshu cũng dùng chung ô nhập này — được nhận diện tự động.", placeholder: "Dán link chia sẻ Xiaohongshu (vd: https://xhslink.com/...)" },
    th: { title: "เครื่องมือลบลายน้ำ Xiaohongshu", note: "ลิงก์ Xiaohongshu ก็ใช้ช่องกรอกเดียวกันนี้ได้ — ระบบจะตรวจจับให้อัตโนมัติ", placeholder: "วางลิงก์แชร์ Xiaohongshu (เช่น https://xhslink.com/...)" },
    id: { title: "Penghapus Watermark Xiaohongshu", note: "Link Xiaohongshu juga bisa ditempel di kotak yang sama — akan terdeteksi otomatis.", placeholder: "Tempel link Xiaohongshu (contoh: https://xhslink.com/...)" },
    km: { title: "កម្មវិធីលុបស្លាកទឹក Xiaohongshu", note: "តំណភ្ជាប់ Xiaohongshu ក៏ប្រើប្រអប់បញ្ចូលដូចគ្នានេះដែរ — នឹងត្រូវបានរកឃើញដោយស្វ័យប្រវត្តិ។", placeholder: "បិទភ្ជាប់តំណភ្ជាប់ Xiaohongshu (ឧទាហរណ៍៖ https://xhslink.com/...)" },
  },
};

// 현재 선택된 탭 상태 + 이 페이지의 고정 언어 (언어는 이제 URL 자체가 다르므로,
// 이 페이지가 어떤 언어 버전인지는 <html lang="..."> 값으로 고정됩니다.)
let currentFormat = "video"; // 기본값: 틱톡(첫 화면에 이미 활성화된 탭과 일치)
let currentLang = document.documentElement.lang || "ko";

function updateHero() {
  if (currentFormat && TAB_CONTENT[currentFormat]) {
    const c = TAB_CONTENT[currentFormat][currentLang] || TAB_CONTENT[currentFormat].ko;
    heroTitle.textContent = c.title;
    formatNote.textContent = c.note;
    urlInput.placeholder = c.placeholder;
  } else {
    const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.ko;
    heroTitle.textContent = dict.hero_title;
    urlInput.placeholder = dict.input_placeholder;
    formatNote.textContent = "";
  }
}

const formatButtons = document.querySelectorAll("[data-format]");

formatButtons.forEach((btn) => {
  btn.addEventListener("click", (e) => {
    if (btn.tagName === "A") e.preventDefault();

    const format = btn.dataset.format;

    // 같은 종류(탭 버튼끼리 / 네비 링크끼리)의 active 상태만 전환
    formatButtons.forEach((b) => {
      if (b.dataset.format === format) {
        b.classList.add("active");
      } else if (b.tagName === btn.tagName) {
        b.classList.remove("active");
      }
    });

    currentFormat = format;
    updateHero();

    // 실제로 눈에 보이는 반응: 입력창으로 스크롤 + 포커스
    urlInput.closest(".search-form").scrollIntoView({ behavior: "smooth", block: "center" });
    urlInput.focus();
  });
});

// ── 다국어 전환 ──
// 페이지 전체를 번역하지는 않고, 위쪽 핵심 영역(제목/버튼/안내 문구)만
// 즉시 전환합니다. FAQ·본문 설명은 한국어로 유지됩니다.
const TRANSLATIONS = {
  ko: {
    nav_video: "틱톡 비디오", nav_mp3: "틱톡 MP3", nav_photo: "틱톡 사진",
    nav_douyin: "더우인", nav_xhs: "샤오홍슈",
    hero_title: "틱톡·더우인·샤오홍슈 워터마크 제거 다운로더",
    hero_subtitle: "공유 링크만 붙여넣으면 로고 없는 원본 화질 그대로 저장해드려요.",
    submit_btn: "다운로드",
    device_iphone: "📱 iPhone에서 저장하기", device_android: "🤖 Android에서 저장하기", device_pc: "💻 PC에서 저장하기",
    loading_text: "영상 정보를 불러오는 중이에요. 몇 초만 기다려 주세요.",
    more_downloads: "더 많은 다운로드",
    input_placeholder: "틱톡·더우인·샤오홍슈 공유 링크를 붙여넣으세요",
  },
  en: {
    nav_video: "TikTok Video", nav_mp3: "TikTok MP3", nav_photo: "TikTok Photo",
    nav_douyin: "Douyin", nav_xhs: "Xiaohongshu",
    hero_title: "TikTok · Douyin · Xiaohongshu Watermark Remover",
    hero_subtitle: "Paste a share link and get the original video, no watermark attached.",
    submit_btn: "Download",
    device_iphone: "📱 Save on iPhone", device_android: "🤖 Save on Android", device_pc: "💻 Save on PC",
    loading_text: "Fetching video info — this only takes a few seconds.",
    more_downloads: "More downloads",
    input_placeholder: "Paste a TikTok, Douyin, or Xiaohongshu share link",
  },
  ja: {
    nav_video: "TikTok動画", nav_mp3: "TikTok MP3", nav_photo: "TikTok写真",
    nav_douyin: "Douyin", nav_xhs: "RED(小紅書)",
    hero_title: "TikTok・Douyin・RED 透かし除去ダウンローダー",
    hero_subtitle: "共有リンクを貼り付けるだけで、透かしなしの元動画を保存できます。",
    submit_btn: "ダウンロード",
    device_iphone: "📱 iPhoneで保存", device_android: "🤖 Androidで保存", device_pc: "💻 PCで保存",
    loading_text: "動画情報を取得しています。少々お待ちください。",
    more_downloads: "その他のダウンロード",
    input_placeholder: "TikTok・Douyin・RED の共有リンクを貼り付けてください",
  },
  zh: {
    nav_video: "TikTok 视频", nav_mp3: "TikTok MP3", nav_photo: "TikTok 图片",
    nav_douyin: "抖音", nav_xhs: "小红书",
    hero_title: "TikTok·抖音·小红书 去水印下载器",
    hero_subtitle: "粘贴分享链接，即可获取无水印原画视频。",
    submit_btn: "下载",
    device_iphone: "📱 iPhone 保存方法", device_android: "🤖 Android 保存方法", device_pc: "💻 电脑保存方法",
    loading_text: "正在获取视频信息，请稍候几秒。",
    more_downloads: "更多下载",
    input_placeholder: "请粘贴 TikTok / 抖音 / 小红书 分享链接",
  },
  vi: {
    nav_video: "TikTok Video", nav_mp3: "TikTok MP3", nav_photo: "TikTok Ảnh",
    nav_douyin: "Douyin", nav_xhs: "Xiaohongshu",
    hero_title: "Công cụ xóa watermark TikTok · Douyin · Xiaohongshu",
    hero_subtitle: "Dán liên kết chia sẻ để tải video gốc, không có watermark.",
    submit_btn: "Tải xuống",
    device_iphone: "📱 Lưu trên iPhone", device_android: "🤖 Lưu trên Android", device_pc: "💻 Lưu trên PC",
    loading_text: "Đang lấy thông tin video, vui lòng đợi vài giây.",
    more_downloads: "Tải video khác",
    input_placeholder: "Dán liên kết chia sẻ TikTok, Douyin hoặc Xiaohongshu",
  },
  th: {
    nav_video: "TikTok วิดีโอ", nav_mp3: "TikTok MP3", nav_photo: "TikTok รูปภาพ",
    nav_douyin: "Douyin", nav_xhs: "Xiaohongshu",
    hero_title: "เครื่องมือลบลายน้ำ TikTok · Douyin · Xiaohongshu",
    hero_subtitle: "วางลิงก์แชร์เพื่อดาวน์โหลดวิดีโอต้นฉบับ ไม่มีลายน้ำ",
    submit_btn: "ดาวน์โหลด",
    device_iphone: "📱 บันทึกบน iPhone", device_android: "🤖 บันทึกบน Android", device_pc: "💻 บันทึกบน PC",
    loading_text: "กำลังดึงข้อมูลวิดีโอ กรุณารอสักครู่",
    more_downloads: "ดาวน์โหลดเพิ่มเติม",
    input_placeholder: "วางลิงก์แชร์ TikTok, Douyin หรือ Xiaohongshu",
  },
  id: {
    nav_video: "TikTok Video", nav_mp3: "TikTok MP3", nav_photo: "TikTok Foto",
    nav_douyin: "Douyin", nav_xhs: "Xiaohongshu",
    hero_title: "Penghapus Watermark TikTok · Douyin · Xiaohongshu",
    hero_subtitle: "Tempel link berbagi untuk mengunduh video asli tanpa watermark.",
    submit_btn: "Unduh",
    device_iphone: "📱 Simpan di iPhone", device_android: "🤖 Simpan di Android", device_pc: "💻 Simpan di PC",
    loading_text: "Sedang mengambil info video, mohon tunggu beberapa detik.",
    more_downloads: "Unduhan lainnya",
    input_placeholder: "Tempel link TikTok, Douyin, atau Xiaohongshu",
  },
  km: {
    nav_video: "វីដេអូ TikTok", nav_mp3: "TikTok MP3", nav_photo: "រូបភាព TikTok",
    nav_douyin: "Douyin", nav_xhs: "Xiaohongshu",
    hero_title: "កម្មវិធីលុបស្លាកទឹក TikTok · Douyin · Xiaohongshu",
    hero_subtitle: "បិទភ្ជាប់តំណភ្ជាប់ចែករំលែកដើម្បីទាញយកវីដេអូដើម ដោយគ្មានស្លាកទឹក។",
    submit_btn: "ទាញយក",
    device_iphone: "📱 រក្សាទុកនៅលើ iPhone", device_android: "🤖 រក្សាទុកនៅលើ Android", device_pc: "💻 រក្សាទុកនៅលើ PC",
    loading_text: "កំពុងទាញយកព័ត៌មានវីដេអូ សូមរង់ចាំបន្តិច។",
    more_downloads: "ទាញយកបន្ថែម",
    input_placeholder: "បិទភ្ជាប់តំណភ្ជាប់ TikTok, Douyin ឬ Xiaohongshu",
  },
};

// ── 언어 선택: 이제 그 자리에서 텍스트를 바꾸는 대신, 실제 그 언어의
// 별도 페이지(폴더)로 이동합니다. (SEO를 위해 언어별로 진짜 URL을 분리했어요.
// 한국어는 루트, 나머지는 /en/, /vi/ 같은 하위 폴더에 있습니다.)
const LANG_SUBFOLDERS = ["en", "ja", "zh", "vi", "th", "id", "km"]; // ko는 폴더 없이 루트

function buildLangUrl(targetLang) {
  const inSubfolder = LANG_SUBFOLDERS.includes(currentLang);
  if (targetLang === "ko") {
    return inSubfolder ? "../index.html" : "index.html";
  }
  return inSubfolder ? `../${targetLang}/index.html` : `${targetLang}/index.html`;
}

if (langSelect) {
  langSelect.value = currentLang; // 지금 보고 있는 언어를 셀렉트에 미리 표시
  langSelect.addEventListener("change", (e) => {
    window.location.href = buildLangUrl(e.target.value);
  });
}

updateHero(); // 이 페이지의 고정 언어로 히어로 영역 초기화

// ── FAQ 아코디언 ──
const faqItems = document.querySelectorAll("#faqWrap .faq-item");
faqItems.forEach((item) => {
  const question = item.querySelector(".faq-q");
  question.addEventListener("click", () => {
    const isOpen = item.classList.contains("open");
    faqItems.forEach((i) => i.classList.remove("open")); // 하나만 열리도록
    if (!isOpen) item.classList.add("open");
  });
});

// ── 쿠키 동의 배너 ──
// app.js 한 곳에서만 관리하면 모든 언어 페이지(ko/en/ja/zh/vi/th/id)에 동일하게 적용됩니다.
const COOKIE_BANNER_TEXT = {
  ko: { msg: "이 사이트는 더 나은 서비스 제공과 광고 게재를 위해 쿠키를 사용합니다.", btn: "확인" },
  en: { msg: "This site uses cookies to improve your experience and show relevant ads.", btn: "Got it" },
  ja: { msg: "当サイトはサービス向上と広告表示のためCookieを使用します。", btn: "同意する" },
  zh: { msg: "本站使用 Cookie 以提供更好的服务和广告展示。", btn: "知道了" },
  vi: { msg: "Trang này sử dụng cookie để cải thiện trải nghiệm và hiển thị quảng cáo phù hợp.", btn: "Đã hiểu" },
  th: { msg: "เว็บไซต์นี้ใช้คุกกี้เพื่อปรับปรุงประสบการณ์และแสดงโฆษณาที่เกี่ยวข้อง", btn: "รับทราบ" },
  id: { msg: "Situs ini menggunakan cookie untuk meningkatkan pengalaman Anda dan menampilkan iklan yang relevan.", btn: "Mengerti" },
  km: { msg: "គេហទំព័រនេះប្រើខូគីដើម្បីកែលម្អបទពិសោធន៍របស់អ្នក និងបង្ហាញការផ្សាយពាណិជ្ជកម្មពាក់ព័ន្ធ។", btn: "យល់ព្រម" },
};

function initCookieBanner() {
  try {
    if (localStorage.getItem("cookieConsent") === "yes") return;
  } catch (e) {
    return; // localStorage 접근 불가 환경(일부 file:// 상황 등)에서는 배너를 띄우지 않음
  }

  const text = COOKIE_BANNER_TEXT[currentLang] || COOKIE_BANNER_TEXT.ko;

  const banner = document.createElement("div");
  banner.id = "cookieBanner";
  banner.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;z-index:999;background:#1e293b;color:#fff;" +
    "padding:14px 20px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:center;" +
    "font-size:13px;box-shadow:0 -2px 10px rgba(0,0,0,0.15);";

  const msgSpan = document.createElement("span");
  msgSpan.textContent = text.msg;
  msgSpan.style.cssText = "max-width:640px;line-height:1.5;";

  const btn = document.createElement("button");
  btn.textContent = text.btn;
  btn.style.cssText =
    "background:#4f46e5;color:#fff;border:none;font-weight:700;font-size:13px;" +
    "padding:8px 18px;border-radius:6px;cursor:pointer;flex-shrink:0;";
  btn.addEventListener("click", () => {
    try {
      localStorage.setItem("cookieConsent", "yes");
    } catch (e) {
      /* 저장 실패해도 일단 배너는 닫아줌 */
    }
    banner.remove();
  });

  banner.appendChild(msgSpan);
  banner.appendChild(btn);
  document.body.appendChild(banner);
}

initCookieBanner();

// ── 공유 버튼 ──
(function initShareButtons() {
  const pageUrl = encodeURIComponent(window.location.href);
  const pageTitle = encodeURIComponent(document.title);

  const fb = document.getElementById("shareFacebook");
  if (fb) fb.href = `https://www.facebook.com/sharer/sharer.php?u=${pageUrl}`;

  const tw = document.getElementById("shareTwitter");
  if (tw) tw.href = `https://twitter.com/intent/tweet?url=${pageUrl}&text=${pageTitle}`;

  const tg = document.getElementById("shareTelegram");
  if (tg) tg.href = `https://t.me/share/url?url=${pageUrl}&text=${pageTitle}`;

  const copyBtn = document.getElementById("shareCopy");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => copyLinkWithFeedback(copyBtn));
  }

  async function copyLinkWithFeedback(btn) {
    try {
      await navigator.clipboard.writeText(window.location.href);
      const original = btn.innerHTML;
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => (btn.innerHTML = original), 1500);
    } catch (err) {
      /* 클립보드 접근 실패 시 조용히 무시 */
    }
  }

  // 모바일 등 네이티브 공유 시트를 지원하는 브라우저에서는 공유 버튼도 보여줌
  const nativeBtn = document.getElementById("shareNative");
  if (nativeBtn && navigator.share) {
    nativeBtn.style.display = "flex";
    nativeBtn.addEventListener("click", () => {
      navigator.share({ title: document.title, url: window.location.href }).catch(() => {});
    });
  }
})();
