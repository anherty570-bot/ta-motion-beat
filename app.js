"use strict";

/* =====================================================
   TA MOTION · BEAT MARKER  (v3 – dò beat từ HÌNH ẢNH của video MP4)

   Thay vì phân tích âm thanh, app đọc từng khung hình của video
   (thu nhỏ ~96 px) rồi đo 4 "kênh" thị giác:
     cut    : chuyển cảnh (histogram + sai khác ảnh sau khi bù rung)
     shake  : rung / giật camera (đổi hướng chuyển động toàn khung)
     flash  : chớp sáng / tối đột ngột
     motion : chuyển động mạnh khác (zoom, xoay, vật thể)
   Các kênh được gộp thành đường "độ mạnh sự kiện" rồi đi qua cùng
   pipeline cũ: ước tính tempo → dò beat bằng quy hoạch động →
   chấm điểm quan trọng. Độ nhạy chỉ là ngưỡng lọc theo điểm này.
===================================================== */

const fileInput = document.getElementById("audioFile");
const analyzeBtn = document.getElementById("analyzeBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const fileInfo = document.getElementById("fileInfo");
const canvas = document.getElementById("waveform");
const sensitivityEl = document.getElementById("sensitivity");
const ctx = canvas.getContext("2d");

fileInput.accept = "video/mp4,video/*";

// Dùng thẻ <video>; nếu HTML cũ còn thẻ <audio id="audioPlayer"> thì tự thay.
const videoPlayer = ensureVideoElement();

function ensureVideoElement() {
  const existing =
    document.getElementById("videoPlayer") ||
    document.getElementById("audioPlayer");

  if (existing && existing.tagName === "VIDEO") return existing;

  const video = document.createElement("video");

  video.id = existing?.id || "videoPlayer";
  video.className = existing?.className || "";
  video.controls = true;
  video.playsInline = true;
  video.hidden = true;
  video.style.cssText =
    "width:100%;max-height:360px;background:#000;border-radius:8px;";

  if (existing) existing.replaceWith(video);
  else canvas.insertAdjacentElement("beforebegin", video);

  return video;
}

let mediaInfo = null; // { duration, width, height }
let selectedName = "video";
let analysisData = null;
let analysisToken = 0;
let objectUrl = null;

// Toàn bộ ứng viên đã chấm điểm + danh sách đang hiển thị.
let candidates = [];
let visible = [];
let markerSeconds = [];

/* ---------- cấu hình thuật toán ---------- */

const VIDEO = {
  fps: 30,            // số khung lấy mẫu mỗi giây để phân tích
  minFps: 12,
  maxFrames: 6000,    // video dài quá sẽ tự hạ fps
  longSide: 96,       // cạnh dài của ảnh thu nhỏ (px)
  searchRadius: 6,    // bán kính dò rung toàn khung (px ảnh nhỏ)
  histBins: 32,
  seekTimeoutMs: 3000
};

// Thang chuẩn hoá: giá trị 1.0 = một sự kiện rõ rệt của kênh đó.
const SCALE = { cut: 0.4, shake: 1.5, flash: 14, motion: 8 };

const CUT_HARD = 0.35;    // vượt mức này coi là cắt cảnh → bỏ ước lượng rung
const CHANNEL_CLIP = 3;   // cắt trần để một cú cắt không át hết các cú nhỏ

const CHANNELS = [
  { name: "cut", weight: 1.5 },
  { name: "shake", weight: 1.2 },
  { name: "flash", weight: 0.9 },
  { name: "motion", weight: 0.6 }
];

// Chỉ thêm beat "chỉ có trên lưới nhịp" khi hình ảnh không có gì xảy ra.
const INCLUDE_GRID_ONLY = false;

/*
  Ngưỡng điểm quan trọng (0 – 1):
    low    : chỉ sự kiện rất mạnh (cắt cảnh/rung lớn, trúng lưới nhịp)
    medium : thêm các sự kiện mạnh vừa
    high   : thêm cả chớp sáng / chuyển động nhỏ
*/
const IMPORTANCE_THRESHOLD = {
  low: 0.55,
  medium: 0.4,
  high: 0.2
};

const TYPE_WEIGHT = {
  cut: 1.0,
  shake: 0.85,
  flash: 0.75,
  motion: 0.55,
  grid: 0.0
};

const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

/* =====================================
   NẠP FILE
===================================== */

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];

  if (!file) return;

  const token = ++analysisToken;

  selectedName =
    file.name.replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9_-]/gi, "_") || "video";

  fileInfo.textContent =
    `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);

  videoPlayer.src = objectUrl;
  videoPlayer.hidden = false;

  analyzeBtn.disabled = true;
  downloadBtn.disabled = true;

  candidates = [];
  visible = [];
  markerSeconds = [];
  mediaInfo = null;
  analysisData = null;

  clearStats();

  statusEl.textContent = "Đang đọc video…";

  try {
    const info = await loadVideoMetadata(objectUrl);

    if (token !== analysisToken) return;

    mediaInfo = info;

    analyzeBtn.disabled = false;

    statusEl.textContent =
      "Đã sẵn sàng. Nhấn Phân tích nhịp.";

    document.getElementById("duration").textContent =
      formatTime(info.duration);

    drawWaveform();

  } catch (error) {
    console.error(error);

    if (token !== analysisToken) return;

    statusEl.textContent =
      "Không đọc được video. Hãy thử file MP4 (H.264) khác.";
  }
});

function loadVideoMetadata(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");

    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;

    v.onloadedmetadata = () => {
      const info = {
        duration: v.duration,
        width: v.videoWidth,
        height: v.videoHeight
      };

      v.removeAttribute("src");
      v.load();

      if (isFinite(info.duration) && info.duration > 0 && info.width) {
        resolve(info);
      } else {
        reject(new Error("Video không có thời lượng/kích thước hợp lệ"));
      }
    };

    v.onerror = () => reject(new Error("Trình duyệt không giải mã được video"));
    v.src = url;
  });
}

/* =====================================
   PHÂN TÍCH
===================================== */

analyzeBtn.addEventListener("click", async () => {
  if (!mediaInfo) return;

  const token = ++analysisToken;
  const info = mediaInfo;
  const url = objectUrl;

  analyzeBtn.disabled = true;
  downloadBtn.disabled = true;

  statusEl.textContent = "Đang chuẩn bị phân tích…";

  await nextTick();

  try {
    const result = await analyzeVideo(
      url,
      info,
      (percent, stage) => {
        if (token === analysisToken) {
          statusEl.textContent = `${stage} ${percent}%`;
        }
      },
      () => token !== analysisToken
    );

    if (token !== analysisToken || !result) return;

    analysisData = result;
    candidates = result.candidates;

    document.getElementById("bpm").textContent =
      result.bpm ? Math.round(result.bpm) : "—";

    setEnvelope(result.envelope);
    applyVisible();

    const strong = visible.filter(m => m.tier === 2).length;

    statusEl.textContent = visible.length
      ? `Hoàn tất! ${visible.length} marker (${strong} chính) · ` +
        `độ tin cậy nhịp ${result.reliability}%. ` +
        "Đổi độ nhạy để lọc ngay, nhấp đúp lên biểu đồ để thêm/xóa."
      : "Chưa tìm được điểm nhấn rõ ràng. Hãy thử độ nhạy cao hơn.";

  } catch (error) {
    console.error(error);

    if (token === analysisToken) {
      statusEl.textContent = "Lỗi trong quá trình phân tích video.";
    }
  }

  if (token === analysisToken) analyzeBtn.disabled = false;
});

// Đổi độ nhạy: lọc lại tức thì, không cần phân tích lại.
sensitivityEl.addEventListener("change", () => {
  if (candidates.length) applyVisible();
});

/* =====================================
   PIPELINE CHÍNH
===================================== */

async function analyzeVideo(url, info, onProgress, isStale) {
  const report = onProgress || (() => {});
  const duration = info.duration;

  let fps = VIDEO.fps;

  if (duration * fps > VIDEO.maxFrames) {
    fps = Math.max(VIDEO.minFps, Math.floor(VIDEO.maxFrames / duration));
  }

  const frameDur = 1 / fps;

  const flux = await extractVideoFeatures(
    url, info, fps, report, isStale
  );

  if (!flux) return null;

  report(95, "Đang dò nhịp…");
  await nextTick();

  const source = buildOnsetEnvelope(flux, frameDur);
  const env = source.env;

  const tempo = estimateTempo(env, frameDur);

  let beats = [];

  if (tempo) {
    const frames = trimBeats(trackBeats(env, tempo.period), env);
    beats = refineBeats(frames, env, tempo.period, frameDur);
  }

  const onsets = pickOnsets(env, frameDur, 0.3, source.bands);

  const scored = scoreCandidates(onsets, beats, duration, tempo);

  return {
    candidates: scored.candidates,
    bpm: scored.bpm,
    reliability: scored.reliability,
    envelope: Array.from(env)
  };
}

/* =====================================
   ĐỌC KHUNG HÌNH → 4 KÊNH ĐẶC TRƯNG
===================================== */

function waitForEvent(target, name, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Hết thời gian chờ video"));
    }, timeoutMs);

    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error("Lỗi video")); };

    function cleanup() {
      clearTimeout(timer);
      target.removeEventListener(name, ok);
      target.removeEventListener("error", bad);
    }

    target.addEventListener(name, ok);
    target.addEventListener("error", bad);
  });
}

function seekVideo(video, t) {
  return new Promise(resolve => {
    if (Math.abs(video.currentTime - t) < 1e-3 && video.readyState >= 2) {
      resolve();
      return;
    }

    const done = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", done);
      resolve();
    };

    const timer = setTimeout(done, VIDEO.seekTimeoutMs);

    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

// Trả về mảng flux[kênh][khung]; null nếu bị huỷ giữa chừng.
async function extractVideoFeatures(url, info, fps, report, isStale) {
  const duration = info.duration;
  const n = Math.max(3, Math.floor(duration * fps));

  const scale = VIDEO.longSide / Math.max(info.width, info.height);
  const W = Math.max(24, Math.round(info.width * scale));
  const H = Math.max(24, Math.round(info.height * scale));

  const flux = CHANNELS.map(() => new Float32Array(n));

  const video = document.createElement("video");

  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  try {
    if (video.readyState < 2) await waitForEvent(video, "loadeddata");

    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;

    const c2 = cv.getContext("2d", { willReadFrequently: true });

    const bins = VIDEO.histBins;

    let prev = new Uint8Array(W * H);
    let cur = new Uint8Array(W * H);
    let prevHist = new Float32Array(bins);
    let curHist = new Float32Array(bins);

    let prevMean = 0;
    let prevDx = 0;
    let prevDy = 0;

    const lastTime = Math.max(0, duration - 0.001);

    for (let i = 0; i < n; i++) {
      if (isStale()) return null;

      // Lấy mẫu giữa khoảng khung để chắc chắn rơi vào đúng khung hình.
      await seekVideo(video, Math.min(lastTime, (i + 0.5) / fps));

      c2.drawImage(video, 0, 0, W, H);

      const rgba = c2.getImageData(0, 0, W, H).data;
      const mean = grabLuma(rgba, cur, curHist);

      if (i > 0) {
        const f = frameFeatures(
          prev, cur, prevHist, curHist, W, H, prevDx, prevDy
        );

        flux[0][i] = f.cut / SCALE.cut;
        flux[1][i] = f.shake / SCALE.shake;
        flux[2][i] = Math.abs(mean - prevMean) / SCALE.flash;
        flux[3][i] = f.motion / SCALE.motion;

        prevDx = f.dx;
        prevDy = f.dy;
      }

      prevMean = mean;

      let t = prev; prev = cur; cur = t;
      t = prevHist; prevHist = curHist; curHist = t;

      if (i % 8 === 0) {
        report(
          Math.round((i / n) * 92),
          "Đang phân tích hình ảnh…"
        );

        await nextTick();
      }
    }

    return flux;

  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

// RGBA → độ sáng (0–255) + histogram chuẩn hoá; trả về độ sáng trung bình.
function grabLuma(rgba, luma, hist) {
  const shift = 8 - Math.log2(hist.length);

  hist.fill(0);

  let sum = 0;

  for (let p = 0, i = 0; p < luma.length; p++, i += 4) {
    const y = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;

    luma[p] = y;
    sum += y;
    hist[y >> shift]++;
  }

  const inv = 1 / luma.length;

  for (let b = 0; b < hist.length; b++) hist[b] *= inv;

  return sum * inv;
}

function frameFeatures(prev, cur, prevHist, curHist, W, H, prevDx, prevDy) {
  let histDist = 0;

  for (let b = 0; b < curHist.length; b++) {
    histDist += Math.abs(curHist[b] - prevHist[b]);
  }

  histDist *= 0.5;

  const m = estimateGlobalMotion(prev, cur, W, H, VIDEO.searchRadius);

  // Sai khác còn lại sau khi đã bù rung toàn khung.
  const residual = m.sad;
  const cut = histDist + residual / 255;

  if (cut >= CUT_HARD) {
    // Cắt cảnh: ước lượng chuyển động vô nghĩa → không tính rung.
    return { cut, shake: 0, motion: 0, dx: 0, dy: 0 };
  }

  const jerk = Math.hypot(m.dx - prevDx, m.dy - prevDy);
  const mag = Math.hypot(m.dx, m.dy);

  return {
    cut,
    shake: 0.7 * jerk + 0.3 * mag,
    motion: residual,
    dx: m.dx,
    dy: m.dy
  };
}

// Dò dịch chuyển toàn khung (dx, dy) làm SAD nhỏ nhất, có nội suy dưới điểm ảnh.
function estimateGlobalMotion(prev, cur, W, H, R) {
  const x0 = R, x1 = W - R, y0 = R, y1 = H - R;
  const area = (x1 - x0) * (y1 - y0);
  const side = 2 * R + 1;
  const sads = new Float32Array(side * side);

  let bestCost = Infinity;
  let bestRaw = 0;
  let bi = 0;

  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      let sad = 0;

      for (let y = y0; y < y1; y++) {
        const rc = y * W;
        const rp = (y + dy) * W + dx;

        for (let x = x0; x < x1; x++) {
          const d = cur[rc + x] - prev[rp + x];
          sad += d < 0 ? -d : d;
        }
      }

      const idx = (dy + R) * side + (dx + R);

      sads[idx] = sad;

      // Phạt nhẹ dịch chuyển lớn để khung phẳng/đen không cho kết quả ngẫu nhiên.
      const cost = sad + (Math.abs(dx) + Math.abs(dy)) * area * 0.02;

      if (cost < bestCost) {
        bestCost = cost;
        bestRaw = sad;
        bi = idx;
      }
    }
  }

  const bx = bi % side;
  const by = (bi / side) | 0;

  let sx = 0;
  let sy = 0;

  if (bx > 0 && bx < side - 1) {
    sx = subPixel(sads[bi - 1], sads[bi], sads[bi + 1]);
  }

  if (by > 0 && by < side - 1) {
    sy = subPixel(sads[bi - side], sads[bi], sads[bi + side]);
  }

  return { dx: bx - R + sx, dy: by - R + sy, sad: bestRaw / area };
}

function subPixel(a, b, c) {
  const d = a - 2 * b + c;

  if (Math.abs(d) < 1e-6) return 0;

  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
}


/* =====================================
   ONSET ENVELOPE
===================================== */

function buildOnsetEnvelope(flux, frameDur) {
  const n = flux[0].length;
  const env = new Float32Array(n);

  // Các kênh đã ở thang "1 = sự kiện rõ"; chỉ cắt trần để một cú cắt cảnh
  // khổng lồ không át hết các cú rung nhỏ hơn.
  const bands = flux.map(arr => {
    const norm = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      norm[i] = Math.min(CHANNEL_CLIP, arr[i]);
    }

    return norm;
  });

  for (let c = 0; c < CHANNELS.length; c++) {
    const w = CHANNELS[c].weight;

    for (let i = 0; i < n; i++) env[i] += bands[c][i] * w;
  }

  // Trừ xu hướng nền (trung bình trượt ~0.6 s), giữ phần dương.
  const radius = Math.max(2, Math.round(0.3 / frameDur));
  const prefix = new Float64Array(n + 1);

  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];

  const detrended = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n - 1, i + radius);
    const localMean = (prefix[b + 1] - prefix[a]) / (b - a + 1);

    detrended[i] = Math.max(0, env[i] - localMean);
  }

  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    out[i] =
      0.25 * (detrended[i - 1] || 0) +
      0.5 * detrended[i] +
      0.25 * (detrended[i + 1] || 0);
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= Math.max(1, n);

  let variance = 0;
  for (let i = 0; i < n; i++) {
    variance += (out[i] - mean) * (out[i] - mean);
  }

  const std = Math.sqrt(variance / Math.max(1, n)) || 1;

  for (let i = 0; i < n; i++) out[i] /= std;

  return { env: out, bands };
}

/* =====================================
   ƯỚC TÍNH TEMPO (AUTOCORRELATION)
===================================== */

function estimateTempo(env, frameDur) {
  const n = env.length;

  const minLag = Math.max(2, Math.floor(60 / 190 / frameDur));
  const maxLag = Math.ceil(60 / 60 / frameDur);

  if (n < maxLag * 3) return null;

  const maxAc = Math.min(n - 1, maxLag * 4);

  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;

  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = env[i] - mean;

  const ac = new Float32Array(maxAc + 2);

  for (let lag = 0; lag <= maxAc; lag++) {
    let sum = 0;

    for (let i = lag; i < n; i++) {
      sum += x[i] * x[i - lag];
    }

    ac[lag] = sum / (n - lag);
  }

  if (ac[0] <= 0) return null;

  let bestLag = -1;
  let bestScore = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * frameDur);
    const octave = Math.log2(bpm / 118);

    const prior = Math.exp(-0.5 * (octave / 0.9) ** 2);

    let enhanced = ac[lag];

    if (lag * 2 <= maxAc) enhanced += 0.5 * ac[lag * 2];
    if (lag * 4 <= maxAc) enhanced += 0.25 * ac[lag * 4];

    const score = enhanced * prior;

    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag < 0 || bestScore <= 0) return null;

  const period = parabolic(ac, bestLag);

  return {
    period,
    bpm: 60 / (period * frameDur),
    confidence: ac[bestLag] / ac[0]
  };
}

/* =====================================
   DÒ BEAT BẰNG QUY HOẠCH ĐỘNG
===================================== */

function trackBeats(env, period, tightness = 100) {
  const n = env.length;

  const sigma = Math.max(0.8, period / 32);
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(radius * 2 + 1);

  for (let k = -radius; k <= radius; k++) {
    kernel[k + radius] = Math.exp(-0.5 * (k / sigma) ** 2);
  }

  const local = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    let s = 0;

    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += env[j] * kernel[k + radius];
    }

    local[i] = s;
  }

  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.max(lo + 1, Math.round(period * 2));

  const cum = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let bestPrev = -1;

    for (let p = i - hi; p <= i - lo; p++) {
      if (p < 0) continue;

      const d = Math.log((i - p) / period);
      const score = cum[p] - tightness * d * d;

      if (score > best) {
        best = score;
        bestPrev = p;
      }
    }

    if (bestPrev < 0 || (i < hi && best < 0)) {
      cum[i] = local[i];
      back[i] = -1;
    } else {
      cum[i] = local[i] + best;
      back[i] = bestPrev;
    }
  }

  const peaks = [];

  for (let i = 1; i < n - 1; i++) {
    if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) {
      peaks.push(i);
    }
  }

  if (!peaks.length) return [];

  const threshold = 0.5 * median(peaks.map(i => cum[i]));

  let last = peaks[peaks.length - 1];

  for (let q = peaks.length - 1; q >= 0; q--) {
    if (cum[peaks[q]] >= threshold) {
      last = peaks[q];
      break;
    }
  }

  const frames = [];

  for (let i = last; i >= 0; i = back[i]) {
    frames.push(i);
    if (back[i] < 0) break;
  }

  return frames.reverse();
}

function trimBeats(frames, env) {
  if (frames.length < 3) return frames;

  let sq = 0;
  for (const f of frames) sq += env[f] * env[f];

  const threshold = 0.5 * Math.sqrt(sq / frames.length);

  const strength = f =>
    Math.max(env[f - 1] || 0, env[f], env[f + 1] || 0);

  let s = 0;
  let e = frames.length - 1;

  while (s < e && strength(frames[s]) < threshold) s++;
  while (e > s && strength(frames[e]) < threshold) e--;

  return frames.slice(s, e + 1);
}

function refineBeats(frames, env, period, frameDur) {
  const times = [];
  const minSpacing = period * frameDur * 0.4;

  for (const frame of frames) {
    let best = frame;

    for (let j = frame - 2; j <= frame + 2; j++) {
      if (j >= 0 && j < env.length && env[j] > env[best]) best = j;
    }

    const t = parabolic(env, best) * frameDur;

    if (!times.length || t - times[times.length - 1] >= minSpacing) {
      times.push(t);
    }
  }

  return times;
}

/* =====================================
   DÒ ONSET ỨNG VIÊN
===================================== */

function pickOnsets(env, frameDur, k, bands) {
  const n = env.length;

  const prefix = new Float64Array(n + 1);
  const prefix2 = new Float64Array(n + 1);

  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i] + env[i];
    prefix2[i + 1] = prefix2[i] + env[i] * env[i];
  }

  const W = Math.max(4, Math.round(0.5 / frameDur));
  const peakRadius = Math.max(2, Math.round(0.03 / frameDur));
  const floor = 0.3;

  const onsets = [];

  for (let i = 1; i < n - 1; i++) {
    const v = env[i];

    if (v < floor) continue;

    const a = Math.max(0, i - W);
    const b = Math.min(n - 1, i + W);
    const count = b - a + 1;

    const mean = (prefix[b + 1] - prefix[a]) / count;
    const variance =
      (prefix2[b + 1] - prefix2[a]) / count - mean * mean;

    const std = Math.sqrt(Math.max(0, variance));

    if (v < mean + k * std) continue;

    let isPeak = true;

    for (
      let j = Math.max(0, i - peakRadius);
      j <= Math.min(n - 1, i + peakRadius);
      j++
    ) {
      if (env[j] > v || (env[j] === v && j < i)) {
        isPeak = false;
        break;
      }
    }

    if (!isPeak) continue;

    // Cường độ từng kênh quanh đỉnh → xác định loại sự kiện.
    const ch = [];

    for (let c = 0; c < bands.length; c++) {
      let mx = 0;

      for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) {
        mx = Math.max(mx, bands[c][j]);
      }

      ch.push(mx);
    }

    onsets.push({
      time: parabolic(env, i) * frameDur,
      strength: v,
      channels: ch,
      type: classifyOnset(ch)
    });
  }

  return onsets;
}

// Loại sự kiện = kênh có đóng góp (đã nhân trọng số) lớn nhất.
function classifyOnset(ch) {
  let best = 0;
  let bestVal = -Infinity;

  for (let c = 0; c < ch.length; c++) {
    const val = ch[c] * CHANNELS[c].weight;

    if (val > bestVal) {
      bestVal = val;
      best = c;
    }
  }

  return CHANNELS[best].name;
}

/* =====================================
   CHẤM ĐIỂM QUAN TRỌNG
===================================== */

function scoreCandidates(onsets, beats, duration, tempo) {
  const result = [];
  const hasGrid = beats.length >= 4;

  let bpm = tempo ? tempo.bpm : 0;
  let reliability = 0;

  // ---- Độ mạnh tham chiếu (phân vị 90) ----
  const strengths = onsets.map(o => o.strength).sort((a, b) => a - b);
  const p90 = strengths.length
    ? strengths[Math.min(strengths.length - 1, Math.floor(strengths.length * 0.9))]
    : 1;

  if (!hasGrid) {
    // Không có lưới nhịp: chỉ dựa vào độ mạnh và loại trống.
    for (const o of onsets) {
      const S = Math.min(1, o.strength / (1.2 * p90));
      const T = TYPE_WEIGHT[o.type];
      const base = 0.75 * S + 0.1;

      result.push(makeCandidate(o.time, Math.min(1, base * (0.45 + 0.55 * T)), o.type));
    }

    return {
      candidates: dedupe(result),
      bpm,
      reliability: 0
    };
  }

  // ---- Thống kê lưới nhịp ----
  const intervals = [];

  for (let i = 1; i < beats.length; i++) {
    intervals.push(beats[i] - beats[i - 1]);
  }

  const periodSec = median(intervals);
  bpm = 60 / periodSec;

  const regular =
    intervals.filter(d => Math.abs(d - periodSec) < periodSec * 0.08).length /
    intervals.length;

  const onsetTimes = onsets.map(o => o.time);

  const nearestOnset = (t, tol) => {
    const i = lowerBound(onsetTimes, t);
    let best = -1;
    let bestDist = tol;

    for (const j of [i - 1, i]) {
      if (j >= 0 && j < onsets.length) {
        const d = Math.abs(onsetTimes[j] - t);

        if (d <= bestDist) {
          bestDist = d;
          best = j;
        }
      }
    }

    return best;
  };

  let supported = 0;
  const unsupportedBeats = [];

  for (const t of beats) {
    if (nearestOnset(t, 0.08) >= 0) supported++;
    else unsupportedBeats.push(t);
  }

  const support = supported / beats.length;

  reliability = Math.round(100 * support * (0.4 + 0.6 * regular));

  // ---- Lưới nhịp mở rộng ra hai đầu bài ----
  const { grid } = extendGrid(beats, duration);

  // ---- Downbeat (phách 1) – cắt cảnh/rung thường rơi vào phách đầu ô nhịp ----
  const cutSum = [0, 0, 0, 0];
  const shakeSum = [0, 0, 0, 0];
  const phaseCount = [0, 0, 0, 0];

  for (let i = 0; i < grid.length; i++) {
    const j = nearestOnset(grid[i], 0.08);
    const ph = i % 4;

    phaseCount[ph]++;

    if (j >= 0) {
      cutSum[ph] += onsets[j].channels[0];
      shakeSum[ph] += onsets[j].channels[1];
    }
  }

  const avg = (arr, p) => arr[p] / Math.max(1, phaseCount[p]);

  let downPhase = 0;
  let downBest = -Infinity;

  for (let p = 0; p < 4; p++) {
    const score = avg(cutSum, p) + 0.5 * avg(shakeSum, p);

    if (score > downBest) {
      downBest = score;
      downPhase = p;
    }
  }

  // ---- Vị trí từng onset trên ô nhịp (16 khe / bar) ----
  const classIndex = { cut: 0, shake: 1, flash: 2, motion: 3 };
  const occupancy = [0, 1, 2, 3].map(() => new Float32Array(16));

  for (const o of onsets) {
    const j = lowerBound(grid, o.time) - 1;

    o.slot = -1;
    o.slotError = 1;

    if (j < 0 || j >= grid.length - 1) continue;

    const phase = (o.time - grid[j]) / (grid[j + 1] - grid[j]);
    const barPos = (j - downPhase + phase) * 4;
    const rounded = Math.round(barPos);

    o.slot = ((rounded % 16) + 16) % 16;
    o.slotError = Math.abs(barPos - rounded);

    if (o.slotError < 0.35) {
      occupancy[classIndex[o.type]][o.slot]++;
    }
  }

  const bars = Math.max(1, Math.floor(grid.length / 4));

  // ---- Tính điểm ----
  for (const o of onsets) {
    const S = Math.min(1, o.strength / (1.2 * p90));
    const T = TYPE_WEIGHT[o.type];

    let G = 0.1;
    let R = 0.05;
    let bonus = 0;

    if (o.slot >= 0 && o.slotError < 0.35) {
      const fit = Math.max(0, 1 - o.slotError * 1.5);

      if (o.slot % 4 === 0) G = 1.0 * fit;
      else if (o.slot % 4 === 2) G = 0.6 * fit;
      else G = 0.3 * fit;

      R = Math.min(
        1,
        occupancy[classIndex[o.type]][o.slot] / (0.4 * bars)
      );

      if (o.slot === 0) bonus = 0.15;
      else if (o.slot % 4 === 0) bonus = 0.05;
    }

    const base = 0.6 * S + 0.2 * G + 0.1 * R + bonus;
    const importance = Math.min(1, base * (0.45 + 0.55 * T));

    result.push(makeCandidate(o.time, importance, o.type));
  }

  // Beat của lưới mà hình ảnh không có gì xảy ra: mặc định bỏ qua.
  if (INCLUDE_GRID_ONLY) {
    const gridImportance = support >= 0.5 ? 0.52 : 0.2;

    for (const t of unsupportedBeats) {
      result.push(makeCandidate(t, gridImportance, "grid"));
    }
  }

  return {
    candidates: dedupe(result),
    bpm,
    reliability
  };
}

function makeCandidate(time, importance, type) {
  return {
    time,
    importance,
    type,
    tier: importance >= IMPORTANCE_THRESHOLD.low ? 2
      : importance >= IMPORTANCE_THRESHOLD.medium ? 1
        : 0,
    manual: false,
    deleted: false
  };
}

// Hai ứng viên quá gần nhau: giữ cái quan trọng hơn.
function dedupe(list) {
  list.sort((a, b) => a.time - b.time);

  const out = [];

  for (const c of list) {
    const last = out[out.length - 1];

    if (last && c.time - last.time < 0.07) {
      if (c.importance > last.importance) out[out.length - 1] = c;
    } else {
      out.push(c);
    }
  }

  return out;
}

// Kéo dài lưới beat ra đầu và cuối bài để gán khe nhịp cho mọi onset.
function extendGrid(beats, duration) {
  const grid = beats.slice();

  const front = Math.max(0.2, grid[1] - grid[0]);
  const back = Math.max(0.2, grid[grid.length - 1] - grid[grid.length - 2]);

  let offset = 0;

  while (grid[0] - front >= 0) {
    grid.unshift(grid[0] - front);
    offset++;
  }

  grid.unshift(grid[0] - front);
  offset++;

  while (grid[grid.length - 1] + back <= duration) {
    grid.push(grid[grid.length - 1] + back);
  }

  grid.push(grid[grid.length - 1] + back);

  return { grid, offset };
}

/* =====================================
   TIỆN ÍCH TOÁN HỌC
===================================== */

function median(values) {
  if (!values.length) return 0;

  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parabolic(arr, i) {
  if (i <= 0 || i >= arr.length - 1) return i;

  const a = arr[i - 1];
  const b = arr[i];
  const c = arr[i + 1];

  const d = a - 2 * b + c;

  if (Math.abs(d) < 1e-9) return i;

  const delta = (0.5 * (a - c)) / d;

  return i + Math.max(-0.5, Math.min(0.5, delta));
}

function lowerBound(sortedArr, value) {
  let lo = 0;
  let hi = sortedArr.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (sortedArr[mid] < value) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

/* =====================================
   QUẢN LÝ MARKER
===================================== */

// Lọc ứng viên theo độ nhạy hiện tại (marker thủ công luôn hiện).
function applyVisible() {
  const threshold =
    IMPORTANCE_THRESHOLD[sensitivityEl.value] ??
    IMPORTANCE_THRESHOLD.medium;

  visible = candidates
    .filter(c => !c.deleted && (c.manual || c.importance >= threshold))
    .sort((a, b) => a.time - b.time);

  markerSeconds = visible.map(m => m.time);

  const strong = visible.filter(m => m.tier === 2 || m.manual).length;

  document.getElementById("markers").textContent = visible.length;

  document.getElementById("beatCount").textContent =
    `${visible.length} marker (${strong} chính)`;

  downloadBtn.disabled = visible.length === 0;

  resetClickCursor();
  drawWaveform();
}

// Nhấp đúp lên sóng âm: xóa marker gần nhất hoặc thêm marker mới.
canvas.addEventListener("dblclick", event => {
  if (!mediaInfo) return;

  const rect = canvas.getBoundingClientRect();
  const duration = mediaInfo.duration;
  const time = ((event.clientX - rect.left) / rect.width) * duration;
  const tolerance = (8 / rect.width) * duration;

  let nearest = null;
  let nearestDist = Infinity;

  for (const m of visible) {
    const d = Math.abs(m.time - time);

    if (d < nearestDist) {
      nearestDist = d;
      nearest = m;
    }
  }

  if (nearest && nearestDist <= tolerance) {
    if (nearest.manual) {
      candidates = candidates.filter(c => c !== nearest);
    } else {
      nearest.deleted = true;
    }
  } else {
    candidates.push({
      time: Math.max(0, Math.min(duration, time)),
      importance: 1,
      type: "manual",
      tier: 2,
      manual: true,
      deleted: false
    });
  }

  applyVisible();
});

canvas.addEventListener("click", event => {
  if (!mediaInfo) return;

  const rect = canvas.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;

  videoPlayer.currentTime =
    Math.max(0, Math.min(1, ratio)) * mediaInfo.duration;
});

/* =====================================
   NGHE THỬ MARKER BẰNG TIẾNG CLICK (phát cùng video)
===================================== */

let clickToggle = document.getElementById("clickPreview");

if (!clickToggle) {
  const label = document.createElement("label");

  label.style.cssText =
    "display:inline-flex;align-items:center;gap:6px;" +
    "margin-left:12px;font-size:14px;cursor:pointer;";

  clickToggle = document.createElement("input");
  clickToggle.type = "checkbox";
  clickToggle.id = "clickPreview";

  label.appendChild(clickToggle);
  label.appendChild(document.createTextNode("Nghe thử marker (click)"));

  downloadBtn.insertAdjacentElement("afterend", label);
}

let clickContext = null;
let clickIndex = 0;
let rafId = 0;

function ensureClickContext() {
  if (!clickContext) {
    const AudioCtx =
      window.AudioContext || window.webkitAudioContext;

    clickContext = new AudioCtx();
  }

  if (clickContext.state === "suspended") clickContext.resume();
}

function playClick(strong, delay) {
  const start = clickContext.currentTime + Math.max(0, delay);

  const osc = clickContext.createOscillator();
  const gain = clickContext.createGain();

  osc.type = "sine";
  osc.frequency.value = strong ? 2200 : 1300;

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(strong ? 0.5 : 0.3, start + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.05);

  osc.connect(gain);
  gain.connect(clickContext.destination);

  osc.start(start);
  osc.stop(start + 0.06);
}

function resetClickCursor() {
  clickIndex = lowerBound(markerSeconds, videoPlayer.currentTime);
}

function previewLoop() {
  const now = videoPlayer.currentTime;

  if (clickToggle.checked && !videoPlayer.paused && clickContext) {
    const lookahead = 0.05;

    while (
      clickIndex < visible.length &&
      visible[clickIndex].time <= now + lookahead
    ) {
      const m = visible[clickIndex];

      if (m.time > now - 0.08) {
        playClick(m.tier === 2 || m.manual, m.time - now);
      }

      clickIndex++;
    }
  }

  drawWaveform();

  if (!videoPlayer.paused) {
    rafId = requestAnimationFrame(previewLoop);
  }
}

videoPlayer.addEventListener("play", () => {
  if (clickToggle.checked) ensureClickContext();

  resetClickCursor();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(previewLoop);
});

videoPlayer.addEventListener("pause", () => {
  cancelAnimationFrame(rafId);
  drawWaveform();
});

videoPlayer.addEventListener("ended", () => {
  cancelAnimationFrame(rafId);
  drawWaveform();
});

videoPlayer.addEventListener("seeked", () => {
  resetClickCursor();
  drawWaveform();
});

clickToggle.addEventListener("change", () => {
  if (clickToggle.checked) ensureClickContext();
  resetClickCursor();
});

/* =====================================
   XUẤT XML ALIGHT MOTION
===================================== */

downloadBtn.addEventListener("click", () => {
  if (!markerSeconds.length) return;

  const fps = Number(
    document.getElementById("fps").value
  ) || 30;

  const width = Number(
    document.getElementById("width").value
  );

  const height = Number(
    document.getElementById("height").value
  );

  /*
    Marker được snap vào khung hình theo fps để khớp chính xác
    với timeline, rồi loại bỏ các marker trùng nhau.

    Lưu ý:
    Đơn vị thời gian bookmark hiện được giả định là ms.
    Cần thử nhập XML trong Alight Motion để xác nhận.
  */

  const times = [
    ...new Set(
      markerSeconds.map(seconds =>
        Math.round((Math.round(seconds * fps) / fps) * 1000)
      )
    )
  ].sort((a, b) => a - b);

  const bookmarks = times
    .map(ms => `  <bookmark t="${ms}" />`)
    .join("\n");

  const xml = `<?xml version='1.0' encoding='UTF-8' ?>
<!-- Generated by TA Motion Beat Marker -->
<scene title="${escapeXml(selectedName)}"
 width="${width}"
 height="${height}"
 exportWidth="${width}"
 exportHeight="${height}"
 precompose="dynamicResolution"
 bgcolor="#ff000000"
 totalTime="0"
 fps="${fps}"
 modifiedTime="${Date.now()}"
 amver="106019"
 ffver="106"
 am="com.am.nxkfamx/5.0.161.106019"
 amplatform="android"
 retime="freeze"
 retimeAdaptFPS="false">
${bookmarks}
</scene>`;

  const blob = new Blob(
    [xml],
    { type: "application/xml;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");

  link.href = url;
  link.download = `${selectedName}_beat_markers.xml`;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1500);
});

/* =====================================
   VẼ BIỂU ĐỒ
===================================== */

const view = { envelope: [], max: 1 };

function setEnvelope(envelope) {
  let max = 0;

  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i] > max) max = envelope[i];
  }

  view.envelope = envelope;
  view.max = max || 1;
}

function drawWaveform() {
  const dpr = window.devicePixelRatio || 1;

  const width = Math.max(300, canvas.clientWidth);
  const height = 120;

  const duration = mediaInfo?.duration || 1;

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const envelope = view.envelope;

  if (!envelope.length) {
    ctx.strokeStyle = "#29334b";
    ctx.beginPath();
    ctx.moveTo(0, 60);
    ctx.lineTo(width, 60);
    ctx.stroke();
    return;
  }

  ctx.strokeStyle = "#51d9d0";
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = 0; x < width; x++) {
    const from = Math.floor((x * envelope.length) / width);

    const to = Math.max(
      from + 1,
      Math.floor(((x + 1) * envelope.length) / width)
    );

    let peak = 0;

    for (let i = from; i < to && i < envelope.length; i++) {
      if (envelope[i] > peak) peak = envelope[i];
    }

    const value = Math.pow(peak / view.max, 0.7);
    const h = Math.max(2, value * 50);

    ctx.moveTo(x + 0.5, 60 - h);
    ctx.lineTo(x + 0.5, 60 + h);
  }

  ctx.stroke();

  // Chiều cao và màu vạch phản ánh độ quan trọng:
  // hồng = chính, cam = trung bình, xám = phụ, xanh lá = thủ công.
  for (const m of visible) {
    const x = (m.time / duration) * width;

    let color = "#8896b3";
    let top = 40;
    let bottom = 80;
    let lineWidth = 1;

    if (m.manual) {
      color = "#7dff8a";
      top = 5;
      bottom = 115;
      lineWidth = 1.5;
    } else if (m.tier === 2) {
      color = "#ff668e";
      top = 5;
      bottom = 115;
      lineWidth = 1.5;
    } else if (m.tier === 1) {
      color = "#ffb347";
      top = 22;
      bottom = 98;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;

    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }

  if (mediaInfo && videoPlayer.currentTime > 0) {
    const x = (videoPlayer.currentTime / duration) * width;

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

/* =====================================
   TIỆN ÍCH
===================================== */

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);

  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function clearStats() {
  document.getElementById("duration").textContent = "—";
  document.getElementById("bpm").textContent = "—";
  document.getElementById("markers").textContent = "0";
  document.getElementById("beatCount").textContent = "0 marker";

  setEnvelope([]);
  drawWaveform();
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, character => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;"
  })[character]);
}

window.addEventListener("resize", () => {
  if (mediaInfo) drawWaveform();
});
