"""
워터마크 없는 원본 영상 URL 추출 API
- 지원 플랫폼: TikTok, 더우인(Douyin), 샤오홍슈(Xiaohongshu / RED)
- FastAPI + httpx 기반

실행 방법:
    pip install fastapi uvicorn httpx gmssl --break-system-packages
    uvicorn main:app --reload --port 8000

주의사항:
    - 세 플랫폼 모두 비공식 페이지/API 파싱 방식이므로, 플랫폼이 구조를
      변경하면 파싱 로직(JSON 경로 등)을 업데이트해야 합니다.
    - 과도한 요청은 IP 차단으로 이어질 수 있으니 요청 빈도를 조절하세요.
    - 더우인은 중국 외 지역 IP를 차단하는 경우가 있어, 정상적인 서명값을
      만들어도 네트워크 자체가 막힐 수 있습니다.
"""

import json
import random
import re
import time
from collections import defaultdict
from typing import Optional
from urllib.parse import urlparse, urlencode

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# --------------------------------------------------------------------------
# FastAPI 앱 & CORS 설정
# --------------------------------------------------------------------------

app = FastAPI(
    title="워터마크 없는 영상 추출 API",
    description="TikTok / 샤오홍슈 영상 링크로부터 워터마크 없는 원본 MP4 URL을 추출합니다.",
    version="1.0.0",
)

# 운영 환경에서는 "*" 대신 실제 프론트엔드 도메인을 명시하는 것을 권장합니다.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 예: ["https://notedown.example.com"]
    allow_credentials=False,  # 쿠키/인증정보를 쓰지 않으므로 False로 둬야 "*" 와 함께 안전하게 동작합니다.
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# 간단한 요청 제한(rate limit)
# --------------------------------------------------------------------------
# 별도 패키지(Redis 등) 없이 메모리에서만 처리하는 가벼운 방식입니다.
# 서버가 재시작되면 기록이 초기화되고, 여러 대의 서버로 확장하면 서버별로
# 따로 카운트되니 참고하세요 (지금 규모에서는 충분합니다).

RATE_LIMIT_WINDOW_SECONDS = 60  # 이 시간(초) 동안
RATE_LIMIT_MAX_REQUESTS = 10  # 같은 IP에서 최대 이만큼만 허용

_request_log: dict[str, list[float]] = defaultdict(list)


def check_rate_limit(client_ip: str) -> None:
    now = time.time()
    timestamps = _request_log[client_ip]
    while timestamps and timestamps[0] < now - RATE_LIMIT_WINDOW_SECONDS:
        timestamps.pop(0)
    if len(timestamps) >= RATE_LIMIT_MAX_REQUESTS:
        raise HTTPException(
            status_code=429,
            detail=(
                f"요청이 너무 많아요. {RATE_LIMIT_WINDOW_SECONDS}초 동안 최대 "
                f"{RATE_LIMIT_MAX_REQUESTS}번까지만 가능합니다. 잠시 후 다시 시도해주세요."
            ),
        )
    timestamps.append(now)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc: Exception):
    """
    처리되지 않은 예외(파싱 코드에서 예상 못 한 KeyError/IndexError 등)가 나면
    FastAPI 기본 동작은 CORS 미들웨어 '바깥'에서 500 응답을 만들어버려서,
    브라우저에는 실제 원인 대신 "CORS 정책에 의해 차단됨"으로 잘못 표시됩니다.
    이 핸들러가 그 예외를 직접 잡아서, CORS 헤더가 정상적으로 붙는 JSON 응답으로
    바꿔주고, 실제 에러 내용도 detail에 담아 프론트엔드에서 확인할 수 있게 합니다.
    """
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=500,
        content={"detail": f"서버 내부 오류: {type(exc).__name__}: {exc}"},
    )

# --------------------------------------------------------------------------
# 랜덤 User-Agent 로직
# --------------------------------------------------------------------------

USER_AGENTS = [
    # 데스크탑 Chrome (Windows)
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    # 데스크탑 Chrome (Mac)
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    # iPhone Safari
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
    # 안드로이드 Chrome
    "Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    # 데스크탑 Firefox
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    # iPad Safari
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
]


def get_random_headers(referer: Optional[str] = None) -> dict:
    """요청마다 무작위 User-Agent와 그럴듯한 브라우저 헤더를 생성합니다."""
    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate",  # br(Brotli)은 디코더 라이브러리가 없으면 응답이 깨질 수 있어 제외
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
    }
    if referer:
        headers["Referer"] = referer
    return headers


# --------------------------------------------------------------------------
# 응답 모델
# --------------------------------------------------------------------------

class VideoQuality(BaseModel):
    label: str  # 예: "HD 720p", "SD 480p"
    url: str
    bitrate: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None


class ExtractResult(BaseModel):
    platform: str
    original_url: str
    video_url: str  # 대표(최고 화질) URL - 기존 프론트엔드 호환용
    qualities: list[VideoQuality] = []  # 실제 존재하는 화질/미러 옵션 전부
    audio_url: Optional[str] = None  # 배경음악 등 별도 오디오 트랙(실제 존재할 때만)
    duration: Optional[int] = None  # 초 단위
    cover_url: Optional[str] = None
    title: Optional[str] = None
    author: Optional[str] = None


# --------------------------------------------------------------------------
# 플랫폼 판별
# --------------------------------------------------------------------------

def detect_platform(url: str) -> str:
    host = urlparse(url).netloc.lower()
    if "tiktok.com" in host:
        return "tiktok"
    if "douyin.com" in host:
        return "douyin"
    if "xiaohongshu.com" in host or "xhslink.com" in host:
        return "xiaohongshu"
    raise HTTPException(
        status_code=400,
        detail="지원하지 않는 URL입니다 (TikTok, 더우인, 샤오홍슈 링크만 지원).",
    )


def find_first_key(obj, target_key: str):
    """중첩된 dict/list 구조에서 target_key를 재귀적으로 탐색해 첫 값을 반환합니다.

    더우인처럼 페이지 내부 JSON 스키마가 자주 바뀌는 플랫폼에서, 고정된 경로
    대신 특정 키 이름(예: 'play_addr')을 찾아내는 방식이 구조 변경에 더 강건합니다.
    """
    if isinstance(obj, dict):
        if target_key in obj:
            return obj[target_key]
        for value in obj.values():
            found = find_first_key(value, target_key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = find_first_key(item, target_key)
            if found is not None:
                return found
    return None


def label_as_mp4_variants(urls_with_bitrate: list, max_count: int = 3, mirrors_per_resolution: int = 2) -> list:
    """
    (url, bitrate, width, height) 튜플 목록을 받아 화질별로 라벨링합니다.
    width/height가 있으면 "1920x1080"처럼 실제 해상도로 표시합니다. 같은 해상도라도
    백업 서버(미러) 링크는 해상도당 최대 mirrors_per_resolution개까지 살려둡니다
    (하나가 느리거나 막혔을 때 대안으로 쓸 수 있어서요). 미러는 "1920x1080 (백업2)"처럼 표시됩니다.
    width/height 정보가 없는 경우에만 "MP4 HD" / "MP4 [1]" 방식으로 대체합니다.
    url 기준 중복도 제거하며, 버튼이 너무 많아지지 않도록 전체 최대 max_count개까지만 반환합니다.
    """
    seen_urls = set()
    deduped = []
    for item in urls_with_bitrate:
        u, b, w, h = (item + (None, None))[:4] if len(item) < 4 else item
        if not u or u in seen_urls:
            continue
        seen_urls.add(u)
        deduped.append((u, b, w, h))

    if not deduped:
        return []

    # 화질(해상도)별로 그룹핑, 비트레이트 내림차순 정렬 후 해상도당 최대 mirrors_per_resolution개까지만 유지
    by_resolution: dict = {}
    no_resolution = []
    for u, b, w, h in deduped:
        if w and h:
            by_resolution.setdefault((w, h), []).append((u, b, w, h))
        else:
            no_resolution.append((u, b, w, h))

    kept = []
    for key, items in by_resolution.items():
        items.sort(key=lambda x: x[1] or 0, reverse=True)
        kept.extend(items[:mirrors_per_resolution])

    final_list = kept + no_resolution
    final_list.sort(key=lambda x: x[1] or 0, reverse=True)
    final_list = final_list[:max_count]

    # 같은 해상도가 여러 개일 때: 비트레이트가 실제로 다르면(=다른 인코딩) 그
    # 값을 보여주고, 비트레이트까지 같으면(=진짜 동일 파일의 다른 서버 사본)
    # "미러 서버"라고 정직하게 표시합니다. 겉만 다르고 속은 같은데 다른 화질인
    # 것처럼 보이지 않도록 하기 위함입니다.
    bitrates_by_resolution: dict = {}
    for u, b, w, h in final_list:
        if w and h:
            bitrates_by_resolution.setdefault((w, h), set()).add(b)

    resolution_seen_count: dict = {}
    result = []
    mirror_idx = 1
    for i, (u, b, w, h) in enumerate(final_list):
        if w and h:
            key = (w, h)
            resolution_seen_count[key] = resolution_seen_count.get(key, 0) + 1
            n = resolution_seen_count[key]
            bitrate_varies = len(bitrates_by_resolution.get(key, set())) > 1
            if n == 1:
                label = f"{w}x{h}"
            elif bitrate_varies and b:
                label = f"{w}x{h} · {b / 1_000_000:.1f}Mbps"
            else:
                label = f"{w}x{h} [{n}]"
        else:
            label = "MP4 HD" if i == 0 else f"MP4 [{mirror_idx}]"
            mirror_idx += 1
        result.append(VideoQuality(label=label, url=u, bitrate=b, width=w, height=h))
    return result


# --------------------------------------------------------------------------
# TikTok 추출 로직
# --------------------------------------------------------------------------

async def resolve_redirect(client: httpx.AsyncClient, url: str) -> str:
    """vm.tiktok.com, xhslink.com 같은 단축 URL을 최종 URL로 리다이렉트 추적."""
    try:
        resp = await client.get(url, headers=get_random_headers(), follow_redirects=True, timeout=15)
        return str(resp.url)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"URL 리다이렉트 추적 실패: {exc}")


async def extract_tiktok(client: httpx.AsyncClient, url: str) -> ExtractResult:
    final_url = await resolve_redirect(client, url)

    resp = await client.get(
        final_url,
        headers=get_random_headers(referer="https://www.tiktok.com/"),
        follow_redirects=True,
        timeout=15,
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"TikTok 페이지 요청 실패 (status={resp.status_code})")

    html = resp.text

    # TikTok 웹페이지는 __UNIVERSAL_DATA_FOR_REHYDRATION__ 스크립트 태그에
    # 렌더링용 JSON 데이터를 임베드합니다. 여기서 영상 정보를 파싱합니다.
    match = re.search(
        r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>',
        html,
        re.DOTALL,
    )
    if not match:
        raise HTTPException(
            status_code=500,
            detail="TikTok 페이지 구조에서 데이터를 찾지 못했습니다 (사이트 구조 변경 가능성).",
        )

    try:
        data = json.loads(match.group(1))

        # 고정 경로("webapp.video-detail")가 실제 페이지와 다를 수 있어(사이트 구조
        # 변경), 먼저 시도하고 실패하면 itemStruct 키를 재귀적으로 찾습니다.
        item_struct = None
        try:
            item_struct = data["__DEFAULT_SCOPE__"]["webapp.video-detail"]["itemInfo"]["itemStruct"]
        except (KeyError, TypeError):
            item_struct = find_first_key(data, "itemStruct")

        if not item_struct:
            default_scope = data.get("__DEFAULT_SCOPE__")
            scope_keys = list(default_scope.keys()) if isinstance(default_scope, dict) else None
            print(f"[틱톡] itemStruct를 찾지 못함. __DEFAULT_SCOPE__ 최상위 키: {scope_keys}", flush=True)
            raise HTTPException(
                status_code=500,
                detail="TikTok 데이터 파싱 실패: itemStruct를 찾지 못했습니다 (사이트 구조 변경 가능성).",
            )

        video = item_struct["video"]

        # bitrateInfo의 각 화질(PlayAddr.UrlList)에 들어있는 모든 URL을 모아,
        # 실제 해상도(width x height)를 라벨로 사용합니다.
        bitrate_info = video.get("bitrateInfo") or []
        urls_with_bitrate = []
        for entry in bitrate_info:
            play_addr = entry.get("PlayAddr", {})
            width, height = play_addr.get("Width"), play_addr.get("Height")
            for m_url in play_addr.get("UrlList") or []:
                urls_with_bitrate.append((m_url, entry.get("Bitrate"), width, height))
        qualities: list[VideoQuality] = label_as_mp4_variants(urls_with_bitrate)


        video_url = None
        if qualities:
            video_url = qualities[0].url  # label_as_mp4_variants가 이미 비트레이트순 정렬
        if not video_url:
            video_url = video.get("playAddr") or video.get("downloadAddr")
        if not video_url:
            raise KeyError("video_url not found")

        # 배경음악(오디오)은 영상과 별도 트랙으로 제공되는 경우가 많습니다.
        # 정확한 경로를 아직 실제 데이터로 검증 못 해서, 고정 경로 실패 시
        # 재귀 탐색으로도 시도하고 디버그 로그를 남깁니다.
        music = item_struct.get("music") or {}
        audio_url = None
        play_url = music.get("playUrl")
        if isinstance(play_url, dict):
            audio_url_list = play_url.get("UrlList") or []
            audio_url = audio_url_list[0] if audio_url_list else None
        elif isinstance(play_url, str):
            audio_url = play_url

        if not audio_url:
            # 고정 경로 실패 시 재귀 탐색으로 대체 시도
            play_url_fallback = find_first_key(item_struct, "playUrl")
            if isinstance(play_url_fallback, dict):
                fallback_list = play_url_fallback.get("UrlList") or play_url_fallback.get("url_list") or []
                audio_url = fallback_list[0] if fallback_list else None
            elif isinstance(play_url_fallback, str):
                audio_url = play_url_fallback

        if not audio_url:
            print(f"[틱톡] 음원(MP3) URL을 찾지 못함. music 객체 키: {list(music.keys()) if isinstance(music, dict) else music}", flush=True)

        duration = video.get("duration")  # 초 단위로 내려오는 경우가 일반적

        return ExtractResult(
            platform="tiktok",
            original_url=url,
            video_url=video_url,
            qualities=qualities,
            audio_url=audio_url,
            duration=duration if isinstance(duration, int) else None,
            cover_url=video.get("cover") or video.get("originCover"),
            title=item_struct.get("desc"),
            author=item_struct.get("author", {}).get("nickname"),
        )
    except (KeyError, IndexError, TypeError, AttributeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"TikTok 데이터 파싱 실패: {exc} (사이트 구조 변경 가능성).",
        )


# --------------------------------------------------------------------------
# 샤오홍슈(Xiaohongshu / RED) 추출 로직
# --------------------------------------------------------------------------

async def extract_xiaohongshu(client: httpx.AsyncClient, url: str) -> ExtractResult:
    final_url = await resolve_redirect(client, url)

    resp = await client.get(
        final_url,
        headers=get_random_headers(referer="https://www.xiaohongshu.com/"),
        follow_redirects=True,
        timeout=15,
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"샤오홍슈 페이지 요청 실패 (status={resp.status_code})")

    html = resp.text

    # 샤오홍슈는 window.__INITIAL_STATE__ 에 초기 상태 JSON을 임베드합니다.
    match = re.search(r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*</script>", html, re.DOTALL)
    if not match:
        raise HTTPException(
            status_code=500,
            detail="샤오홍슈 페이지 구조에서 데이터를 찾지 못했습니다 (로그인 필요 또는 구조 변경 가능성).",
        )

    raw_json = match.group(1)
    # __INITIAL_STATE__ 내부에 undefined가 값으로 들어있는 경우가 있어 JSON 파싱 전에 보정합니다.
    raw_json = raw_json.replace(":undefined", ":null")

    try:
        data = json.loads(raw_json)

        note = None
        try:
            note_detail_map = data["note"]["noteDetailMap"]
            first_note_id = data["note"]["firstNoteId"]
            note = note_detail_map[first_note_id]["note"]
        except (KeyError, TypeError):
            note = None

        if note is None:
            # 프로필/모달 등 다른 페이지 유형에서는 noteData.data.noteData 경로를 씁니다.
            try:
                note = data["noteData"]["data"]["noteData"]
            except (KeyError, TypeError):
                note = None

        # 둘 다 못 찾았으면(구조가 또 바뀌었거나 다른 형태) 재귀 탐색으로 fallback
        video_obj = note.get("video") if isinstance(note, dict) else None
        if not video_obj:
            video_obj = find_first_key(data, "video")

        # video.consumer.originVideoKey로 조합하는 링크가 진짜 "원본" 영상입니다
        # (stream.h264의 masterUrl은 공유용 스트림이라 워터마크가 남아있을 수 있음).
        # 참고: XHS-Downloader(오픈소스, GPL-3.0) 프로젝트에서 확인된 방식입니다.
        origin_url = None
        if isinstance(video_obj, dict):
            consumer = video_obj.get("consumer")
            origin_key = consumer.get("originVideoKey") if isinstance(consumer, dict) else None
            if origin_key:
                try:
                    origin_key = origin_key.encode("utf-8").decode("unicode_escape")
                except Exception:
                    pass
                origin_url = f"https://sns-video-bd.xhscdn.com/{origin_key}"

        streams = None
        if isinstance(video_obj, dict):
            # 실제 확인된 경로: video.media.stream.{h264,h265}
            media = video_obj.get("media")
            if isinstance(media, dict):
                streams = media.get("stream")
            if not streams:
                streams = find_first_key(video_obj, "stream")
        if not streams:
            streams = find_first_key(data, "stream")

        # h264/h265 안의 마스터/백업 URL을 전부 모아 실제 해상도를 라벨로 사용합니다.
        urls_with_bitrate: list = []
        if origin_url:
            # 항상 맨 앞(대표 화질)으로 오도록 가상의 높은 비트레이트를 부여
            urls_with_bitrate.append((origin_url, 10**9, None, None))
        if isinstance(streams, dict):
            for codec in ("h264", "h265", "av1"):
                for variant in streams.get(codec) or []:
                    bitrate = variant.get("videoBitrate")
                    width, height = variant.get("width"), variant.get("height")
                    master = variant.get("masterUrl")
                    if master:
                        urls_with_bitrate.append((master, bitrate, width, height))
                    for backup in variant.get("backupUrls") or []:
                        urls_with_bitrate.append((backup, bitrate, width, height))

        qualities: list[VideoQuality] = label_as_mp4_variants(urls_with_bitrate)
        video_url = qualities[0].url if qualities else None

        # streams 구조 자체를 못 찾은 경우, video 객체 바로 아래에 있을 수 있는
        # 다른 흔한 키 이름들도 마지막으로 시도해봅니다.
        if not video_url and isinstance(video_obj, dict):
            video_url = find_first_key(video_obj, "masterUrl") or find_first_key(video_obj, "url")

        if not video_url:
            if video_obj is None:
                raise HTTPException(status_code=400, detail="이 게시물은 동영상이 아닌 것으로 보입니다.")
            raise KeyError("video_url not found")

        image_list = (note.get("imageList") if isinstance(note, dict) else None) or find_first_key(data, "imageList") or []
        cover_url = None
        if image_list and isinstance(image_list, list):
            first_image = image_list[0]
            if isinstance(first_image, dict):
                cover_url = first_image.get("urlDefault") or find_first_key(first_image, "url")
        if not cover_url:
            cover_candidate = find_first_key(data, "cover")
            cover_url = cover_candidate if isinstance(cover_candidate, str) else None

        output_qualities = qualities

        duration = None
        if isinstance(video_obj, dict):
            media = video_obj.get("media")
            if isinstance(media, dict):
                media_video = media.get("video")
                if isinstance(media_video, dict):
                    duration = media_video.get("duration")
            if duration is None:
                duration = find_first_key(video_obj, "duration")

        title = (note.get("title") if isinstance(note, dict) else None) or find_first_key(data, "title")
        author = None
        if isinstance(note, dict):
            author = note.get("user", {}).get("nickname")
        if not author:
            author = find_first_key(data, "nickname")

        return ExtractResult(
            platform="xiaohongshu",
            original_url=url,
            video_url=video_url,
            qualities=output_qualities,
            duration=duration if isinstance(duration, int) else None,
            cover_url=cover_url,
            title=title if isinstance(title, str) else None,
            author=author if isinstance(author, str) else None,
        )
    except HTTPException:
        raise  # 의도적으로 발생시킨 HTTPException(예: 동영상이 아님)은 그대로 전달
    except (KeyError, IndexError, TypeError, AttributeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"샤오홍슈 데이터 파싱 실패: {exc} (사이트 구조 변경 가능성).",
        )


# --------------------------------------------------------------------------
# 더우인(Douyin) 추출 로직
# --------------------------------------------------------------------------
#
# 더우인 웹페이지(프로필/모달 등)는 자바스크립트가 나중에 데이터를 불러오는
# 구조라 HTML을 그대로 읽어서는 데이터에 도달할 수 없는 경우가 많습니다.
# 그래서 더우인의 실제 웹 API(aweme/v1/web/aweme/detail)를 a_bogus 서명과
# 함께 직접 호출하는 방식을 우선 시도하고, 실패하면 기존 HTML 스크래핑
# 방식으로 대체(fallback)합니다.
#
# a_bogus 서명 알고리즘 출처: douyin_abogus.py (같은 폴더에 있어야 합니다)
#   원저작자: https://github.com/JoeanAmier/TikTokDownloader (GPL-3.0)
#   수정: https://github.com/Evil0ctal/Douyin_TikTok_Download_API (Apache-2.0)
#
# 주의: 더우인이 중국 외 IP를 차단하는 경우 이 방식도 실패할 수 있습니다.
# 그 경우 "더우인 API 요청 실패" 에러가 뜹니다.

try:
    from douyin_abogus import ABogus
except ImportError as exc:
    ABogus = None  # douyin_abogus.py가 없거나 gmssl 미설치 시 API 방식은 건너뛰고 HTML 방식만 시도
    print(f"[더우인] douyin_abogus.py 임포트 실패: {exc} → API 방식 비활성화, HTML 방식만 시도됩니다", flush=True)

DOUYIN_API_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36"
)


async def gen_douyin_ttwid(client: httpx.AsyncClient) -> Optional[str]:
    """더우인 요청에 필요한 ttwid 쿠키를 발급받습니다 (브라우저 없이 HTTP 요청만으로 가능)."""
    try:
        resp = await client.post(
            "https://ttwid.bytedance.com/ttwid/union/register/",
            content=json.dumps({
                "region": "cn", "aid": 1768, "needFid": False,
                "service": "www.ixigua.com",
                "migrate_info": {"ticket": "", "source": "node"},
                "cbUrlProtocol": "https", "union": True,
            }),
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        ttwid = resp.cookies.get("ttwid")
        return ttwid
    except Exception as exc:
        print(f"[더우인] ttwid 발급 실패: {type(exc).__name__}: {exc}", flush=True)
        return None


def extract_douyin_aweme_id(url: str) -> Optional[str]:
    """URL에서 영상 고유 ID(aweme_id)를 뽑아냅니다."""
    match = re.search(r"[?&]modal_id=(\d+)", url)  # 프로필 페이지의 모달 영상
    if match:
        return match.group(1)
    match = re.search(r"/video/(\d+)", url)  # 일반 영상 상세 페이지
    if match:
        return match.group(1)
    return None


async def extract_douyin_api(
    client: httpx.AsyncClient, aweme_id: str, original_url: str
) -> Optional[ExtractResult]:
    """더우인 공식 웹 API를 a_bogus 서명과 함께 직접 호출합니다."""
    if ABogus is None:
        return None

    ttwid = await gen_douyin_ttwid(client)

    params = {
        "device_platform": "webapp", "aid": "6383", "channel": "channel_pc_web",
        "pc_client_type": "1", "version_code": "290100", "version_name": "29.1.0",
        "cookie_enabled": "true", "screen_width": "1920", "screen_height": "1080",
        "browser_language": "zh-CN", "browser_platform": "Win32", "browser_name": "Chrome",
        "browser_version": "130.0.0.0", "browser_online": "true", "engine_name": "Blink",
        "engine_version": "130.0.0.0", "os_name": "Windows", "os_version": "10",
        "cpu_core_num": "12", "device_memory": "8", "platform": "PC",
        "aweme_id": aweme_id, "msToken": "",
    }

    try:
        a_bogus = ABogus().get_value(params)
    except Exception as exc:
        print(f"[더우인] a_bogus 서명 생성 실패: {type(exc).__name__}: {exc}", flush=True)
        return None

    endpoint = (
        f"https://www.douyin.com/aweme/v1/web/aweme/detail/?{urlencode(params)}&a_bogus={a_bogus}"
    )
    headers = {
        "User-Agent": DOUYIN_API_UA,
        "Referer": "https://www.douyin.com/",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if ttwid:
        headers["Cookie"] = f"ttwid={ttwid}"

    try:
        resp = await client.get(endpoint, headers=headers, timeout=15)
        if resp.status_code != 200:
            print(f"[더우인] API 응답 실패: status={resp.status_code}", flush=True)
            return None
        response_json = resp.json()
        data = response_json.get("aweme_detail")
        if not data:
            print("[더우인] API 응답에 aweme_detail 없음 (구조 변경 가능성)", flush=True)
            return None
    except Exception as exc:
        print(f"[더우인] API 요청/파싱 실패: {type(exc).__name__}: {exc}", flush=True)
        return None

    video = data.get("video") or {}

    def strip_watermark(u: str) -> str:
        # 더우인은 URL 안의 'playwm'(watermark)을 'play'로만 바꿔도 워터마크 없는
        # 버전이 나오는 경우가 많습니다 (같은 파일의 다른 변형 경로).
        return u.replace("playwm", "play") if u else u

    urls_with_bitrate = []
    for entry in video.get("bit_rate") or []:
        play_addr = entry.get("play_addr") or {}
        url_list = play_addr.get("url_list") or []
        width, height = play_addr.get("width"), play_addr.get("height")
        if url_list:
            # 화질 등급 하나당 미러 서버가 여러 개 있어도 대표로 1개만 사용
            # (안 그러면 화질 수 × 미러 수만큼 버튼이 폭발적으로 늘어남)
            urls_with_bitrate.append((strip_watermark(url_list[0]), entry.get("bit_rate"), width, height))
    if not urls_with_bitrate:
        play_addr = video.get("play_addr") or {}
        width, height = play_addr.get("width"), play_addr.get("height")
        for u in play_addr.get("url_list") or []:
            urls_with_bitrate.append((strip_watermark(u), None, width, height))

    qualities = label_as_mp4_variants(urls_with_bitrate)
    video_url = qualities[0].url if qualities else None
    if not video_url:
        return None

    cover_obj = video.get("cover") or video.get("origin_cover") or {}
    cover_list = cover_obj.get("url_list") or []
    cover_url = cover_list[0] if cover_list else None

    music = data.get("music") or {}
    play_url = music.get("play_url") or {}
    audio_list = play_url.get("url_list") or []
    audio_url = audio_list[0] if audio_list else None

    duration_ms = video.get("duration")
    duration = int(duration_ms / 1000) if isinstance(duration_ms, (int, float)) else None

    return ExtractResult(
        platform="douyin",
        original_url=original_url,
        video_url=video_url,
        qualities=qualities,
        audio_url=audio_url,
        duration=duration,
        cover_url=cover_url,
        title=data.get("desc"),
        author=(data.get("author") or {}).get("nickname"),
    )


async def extract_douyin(client: httpx.AsyncClient, url: str) -> ExtractResult:
    final_url = await resolve_redirect(client, url)

    # 1차 시도: 더우인 공식 API를 직접 호출 (더 안정적, JS 렌더링 불필요)
    aweme_id = extract_douyin_aweme_id(final_url)
    if aweme_id:
        api_result = await extract_douyin_api(client, aweme_id, url)
        if api_result:
            return api_result

    # 2차 시도(fallback): 페이지 HTML에서 직접 데이터 찾기
    resp = await client.get(
        final_url,
        headers=get_random_headers(referer="https://www.douyin.com/"),
        follow_redirects=True,
        timeout=15,
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"더우인 페이지 요청 실패 (status={resp.status_code})")

    html = resp.text
    data = None

    # 1차 시도: RENDER_DATA (URL 인코딩된 JSON)
    match = re.search(
        r'<script id="RENDER_DATA" type="application/json">(.*?)</script>', html, re.DOTALL
    )
    if match:
        try:
            from urllib.parse import unquote

            data = json.loads(unquote(match.group(1)))
        except json.JSONDecodeError:
            data = None

    # 2차 시도: __UNIVERSAL_DATA_FOR_REHYDRATION__ (틱톡과 동일한 스키마를 쓰는 경우)
    if data is None:
        match = re.search(
            r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>',
            html,
            re.DOTALL,
        )
        if match:
            try:
                data = json.loads(match.group(1))
            except json.JSONDecodeError:
                data = None

    if data is None:
        print(f"[더우인] 페이지 구조에서 데이터를 찾지 못함 (HTML 길이={len(html)}자, url={final_url})", flush=True)
        raise HTTPException(
            status_code=500,
            detail="더우인 페이지 구조에서 데이터를 찾지 못했습니다 (사이트 구조 변경 가능성).",
        )

    # play_addr / playAddr 류의 키를 재귀적으로 탐색
    play_addr = find_first_key(data, "play_addr") or find_first_key(data, "playAddr")
    video_url = None
    if isinstance(play_addr, dict):
        url_list = play_addr.get("url_list") or play_addr.get("UrlList")
        if url_list:
            video_url = url_list[0]
    elif isinstance(play_addr, str):
        video_url = play_addr

    if not video_url:
        raise HTTPException(
            status_code=500,
            detail="더우인 영상 주소를 찾지 못했습니다 (사이트 구조 변경 가능성 — 백엔드 파싱 로직 업데이트가 필요할 수 있어요).",
        )

    cover = find_first_key(data, "cover") or find_first_key(data, "origin_cover")
    if isinstance(cover, dict):
        cover_urls = cover.get("url_list")
        cover = cover_urls[0] if cover_urls else None

    title = find_first_key(data, "desc")
    author_info = find_first_key(data, "author") or find_first_key(data, "nickname")
    author = None
    if isinstance(author_info, dict):
        author = author_info.get("nickname")
    elif isinstance(author_info, str):
        author = author_info

    return ExtractResult(
        platform="douyin",
        original_url=url,
        video_url=video_url,
        cover_url=cover if isinstance(cover, str) else None,
        title=title if isinstance(title, str) else None,
        author=author,
    )


# --------------------------------------------------------------------------
# API 엔드포인트
# --------------------------------------------------------------------------

@app.get("/")
async def root():
    return {"status": "ok", "message": "워터마크 없는 영상 추출 API가 정상 동작 중입니다."}


@app.get("/api/extract", response_model=ExtractResult)
async def extract_video(request: Request, url: str = Query(..., description="TikTok 또는 샤오홍슈 영상 URL")):
    client_ip = request.client.host if request.client else "unknown"
    check_rate_limit(client_ip)

    platform = detect_platform(url)

    async with httpx.AsyncClient() as client:
        if platform == "tiktok":
            return await extract_tiktok(client, url)
        elif platform == "douyin":
            return await extract_douyin(client, url)
        else:
            return await extract_xiaohongshu(client, url)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
