"use strict";

/* =====================================================
   TA MOTION · BEAT MARKER  (v3 – nhập MP4, tự trích âm thanh)

   Quy trình:
   0. Nhập file MP4 (hoặc MP3/WAV): trình duyệt tự giải mã lấy riêng
      phần âm thanh, video chỉ dùng để xem trước.
   1. Hạ mẫu về ~22 kHz, STFT.
   2. TÁCH ÂM (HPSS): giữ phần trống, bỏ phần nhạc nền.
   3. Spectral flux 3 dải (kick / snare / hi-hat) trên phần trống.
   4. Tempo (autocorrelation) + dò beat bằng quy hoạch động.
   5. CHẤM ĐIỂM QUAN TRỌNG cho từng cú đập (độ mạnh, loại trống,
      vị trí trên lưới nhịp, tính lặp, downbeat).
   5b. Bài đều nhịp: khớp LƯỚI NHỊP CỨNG (chu kỳ + pha tối ưu) để BPM
      và vị trí phách chính xác thay vì lưới dò động hơi dao động.
   6. CĂN CHỈNH THỜI ĐIỂM đến mức mẫu âm thanh: STFT chỉ cho thời điểm
      thô (~±12 ms), bước này dò lại điểm bắt đầu cú đập thật trên
      dạng sóng nên marker rơi đúng vào đầu transient.
===================================================== */

const fileInput = document.getElementById("audioFile");
const analyzeBtn = document.getElementById("analyzeBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const fileInfo = document.getElementById("fileInfo");
const canvas = document.getElementById("waveform");
const sensitivityEl = document.getElementById("sensitivity");
const ctx = canvas.getContext("2d");

fileInput.accept = "video/mp4,video/*,audio/*,.mp4,.m4a,.mp3,.wav";

// Dùng thẻ <video>; nếu HTML cũ còn <audio id="audioPlayer"> thì tự thay.
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

let audioBuffer = null;
let selectedName = "video";
let analysisData = null;
let analysisToken = 0;
let objectUrl = null;

// Toàn bộ ứng viên đã chấm điểm + danh sách đang hiển thị.
let candidates = [];
let visible = [];
let markerSeconds = [];

/* ---------- cấu hình thuật toán ---------- */

let USE_HPSS = true;

const TARGET_SR = 22050;
const FFT_SIZE = 1024;
const HOP = 256;

const HPSS = {
  timeHalf: 8,     // cửa sổ median theo thời gian: 17 khung (~200 ms)
  freqHalf: 8,     // cửa sổ median theo tần số: 17 bin
  lowCutHz: 250    // dưới mức này dùng mặt nạ theo thời gian (giữ kick)
};

const BANDS = [
  { name: "low", lo: 40, hi: 160, weight: 1.4 },
  { name: "mid", lo: 160, hi: 2500, weight: 1.0 },
  { name: "high", lo: 2500, hi: 11000, weight: 0.6 }
];

/*
  Ngưỡng điểm quan trọng (0 – 1):
    low    : chỉ cú đập chính (kick/snare trúng nhịp, lặp lại đều)
    medium : thêm các cú lặp theo mẫu nhưng kém chính hơn
    high   : thêm hi-hat và cú phụ
*/
const IMPORTANCE_THRESHOLD = {
  low: 0.62,
  medium: 0.5,
  high: 0.25
};

const TYPE_WEIGHT = {
  kick: 1.0,
  snare: 0.95,
  perc: 0.6,
  tone: 0.2,
  hat: 0.15,
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
  audioBuffer = null;
  analysisData = null;

  clearStats();

  statusEl.textContent = "Đang trích xuất âm thanh từ file…";

  try {
    const bytes = await file.arrayBuffer();

    const AudioCtx =
      window.AudioContext || window.webkitAudioContext;

    const audioContext = new AudioCtx();

    const decoded = await audioContext.decodeAudioData(bytes);

    await audioContext.close();

    if (token !== analysisToken) return;

    audioBuffer = decoded;

    analyzeBtn.disabled = false;

    statusEl.textContent =
      "Đã sẵn sàng. Nhấn Phân tích nhịp.";

    document.getElementById("duration").textContent =
      formatTime(audioBuffer.duration);

    drawWaveform();

  } catch (error) {
    console.error(error);

    if (token !== analysisToken) return;

    statusEl.textContent =
      "Không trích được âm thanh từ file này. Hãy dùng Chrome/Edge " +
      "và video MP4 (H.264 + AAC), hoặc thử MP3/WAV.";
  }
});

/* =====================================
   PHÂN TÍCH
===================================== */

analyzeBtn.addEventListener("click", async () => {
  if (!audioBuffer) return;

  const token = ++analysisToken;
  const buffer = audioBuffer;

  analyzeBtn.disabled = true;
  downloadBtn.disabled = true;

  statusEl.textContent = "Đang chuẩn bị phân tích…";

  await nextTick();

  try {
    const result = await analyzeAudio(
      buffer,
      (percent, stage) => {
        if (token === analysisToken) {
          statusEl.textContent = `${stage} ${percent}%`;
        }
      }
    );

    if (token !== analysisToken) return;

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
        "Đổi độ nhạy để lọc ngay, nhấp đúp lên sóng để thêm/xóa."
      : "Chưa tìm được beat rõ ràng. Hãy thử độ nhạy cao hơn.";

  } catch (error) {
    console.error(error);

    if (token === analysisToken) {
      statusEl.textContent = "Lỗi trong quá trình phân tích.";
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

async function analyzeAudio(buffer, onProgress) {
  const report = onProgress || (() => {});

  const { mono, sampleRate } = toMonoDecimated(buffer);
  const frameDur = HOP / sampleRate;
  const duration = buffer.duration;

  const features = await computeFeatures(mono, sampleRate, report);

  report(95, "Đang dò nhịp…");
  await nextTick();

  const percussive = buildOnsetEnvelope(features.percussive);
  const mixed = buildOnsetEnvelope(features.mixed);

  const tempoP = estimateTempo(percussive.env, frameDur);
  const tempoM = estimateTempo(mixed.env, frameDur);

  // Ưu tiên phần trống; chỉ dùng bản gốc khi bài gần như không có trống.
  let source = percussive;
  let tempo = tempoP;

  if (
    !tempoP ||
    (tempoM && tempoM.confidence > tempoP.confidence * 1.35)
  ) {
    source = mixed;
    tempo = tempoM;
  }

  const env = source.env;

  let beats = [];

  if (tempo) {
    const frames = trimBeats(trackBeats(env, tempo.period), env);
    beats = refineBeats(frames, env, tempo.period, frameDur);
  }

  const onsets = pickOnsets(env, frameDur, 0.3, source.bands);

  // Bài đều nhịp: thay lưới dò động (hơi lệch/nhiễu) bằng lưới cứng khớp tối ưu.
  const rigid = fitRigidGrid(onsets, duration, tempo, frameDur);

  if (rigid) {
    beats = rigid.beats;
    tempo = { ...tempo, bpm: rigid.bpm };
  }

  const scored = scoreCandidates(
    onsets,
    beats,
    duration,
    tempo
  );

  // Căn chỉnh thời điểm chính xác trên dạng sóng (bỏ qua beat "grid").
  for (const c of scored.candidates) {
    if (c.type !== "grid") {
      c.time = refineOnsetTime(mono, sampleRate, c.time, c.type);
    }
  }

  return {
    candidates: dedupe(scored.candidates),
    bpm: scored.bpm,
    reliability: scored.reliability,
    envelope: calculateEnergy(mono, HOP)
  };
}

// Hạ mẫu về ~22 kHz và gộp kênh thành mono.
function toMonoDecimated(buffer) {
  const channels = buffer.numberOfChannels;
  const factor = Math.max(1, Math.round(buffer.sampleRate / TARGET_SR));
  const length = Math.floor(buffer.length / factor);

  const mono = new Float32Array(length);

  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);

    for (let i = 0; i < length; i++) {
      let sum = 0;
      const base = i * factor;

      for (let j = 0; j < factor; j++) sum += data[base + j];

      mono[i] += sum;
    }
  }

  const norm = 1 / (factor * channels);

  for (let i = 0; i < length; i++) mono[i] *= norm;

  return { mono, sampleRate: buffer.sampleRate / factor };
}

/* =====================================
   FFT
===================================== */

function createFFT(n) {
  const levels = Math.round(Math.log2(n));
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  const rev = new Uint32Array(n);

  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }

  for (let i = 0; i < n; i++) {
    let r = 0;

    for (let b = 0; b < levels; b++) {
      r = (r << 1) | ((i >> b) & 1);
    }

    rev[i] = r;
  }

  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];

      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;

      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;

          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];

          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  };
}

/* =====================================
   MEDIAN TRƯỢT (cho HPSS)
===================================== */

function medianFilter1D(src, dst, n, half, sorted) {
  const w = half * 2 + 1;

  for (let j = 0; j < w; j++) {
    const v = src[Math.min(n - 1, Math.max(0, j - half))];
    let p = j;

    while (p > 0 && sorted[p - 1] > v) {
      sorted[p] = sorted[p - 1];
      p--;
    }

    sorted[p] = v;
  }

  dst[0] = sorted[half];

  for (let i = 1; i < n; i++) {
    const out = src[Math.max(0, i - 1 - half)];
    const inc = src[Math.min(n - 1, i + half)];

    if (out !== inc) {
      let lo = 0;
      let hi = w - 1;

      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < out) lo = mid + 1;
        else hi = mid;
      }

      let p = lo;
      sorted[p] = inc;

      while (p > 0 && sorted[p - 1] > inc) {
        sorted[p] = sorted[p - 1];
        p--;
      }

      while (p < w - 1 && sorted[p + 1] < inc) {
        sorted[p] = sorted[p + 1];
        p++;
      }

      sorted[p] = inc;
    }

    dst[i] = sorted[half];
  }
}

/* =====================================
   STFT → TÁCH TRỐNG/NHẠC → FLUX 3 DẢI
===================================== */

async function computeFeatures(mono, sampleRate, report) {
  const N = FFT_SIZE;
  const half = N / 2;
  const bins = half + 1;
  const fft = createFFT(N);

  const win = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  }

  const nFrames = Math.floor(mono.length / HOP) + 1;
  const binHz = sampleRate / N;
  const maxHz = (sampleRate / 2) * 0.98;

  const ranges = BANDS.map(band => {
    const lo = Math.max(1, Math.floor(band.lo / binHz));

    let hi = Math.min(
      half - 2,
      Math.ceil(Math.min(band.hi, maxHz) / binHz)
    );

    if (hi <= lo) hi = lo + 1;

    return { lo, hi };
  });

  /* ---- 1. STFT (biên độ tuyến tính) ---- */

  const mag = new Float32Array(nFrames * bins);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const amp = 4 / N;

  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP - half;

    for (let i = 0; i < N; i++) {
      const idx = start + i;

      re[i] =
        idx >= 0 && idx < mono.length
          ? mono[idx] * win[i]
          : 0;

      im[i] = 0;
    }

    fft(re, im);

    const row = f * bins;

    for (let k = 0; k < bins; k++) {
      mag[row + k] =
        Math.sqrt(re[k] * re[k] + im[k] * im[k]) * amp;
    }

    if (f % 150 === 0) {
      report(Math.round((f / nFrames) * 35), "Đang đọc phổ âm thanh…");
      await nextTick();
    }
  }

  /* ---- 2. Thành phần "nhạc": median theo thời gian ---- */

  let harm = null;

  if (USE_HPSS) {
    harm = new Float32Array(nFrames * bins);

    const col = new Float32Array(nFrames);
    const colOut = new Float32Array(nFrames);
    const sortedT = new Float32Array(HPSS.timeHalf * 2 + 1);

    for (let k = 0; k < bins; k++) {
      for (let f = 0; f < nFrames; f++) col[f] = mag[f * bins + k];

      medianFilter1D(col, colOut, nFrames, HPSS.timeHalf, sortedT);

      for (let f = 0; f < nFrames; f++) harm[f * bins + k] = colOut[f];

      if (k % 24 === 0) {
        report(35 + Math.round((k / bins) * 30), "Đang tách nhạc khỏi trống…");
        await nextTick();
      }
    }
  }

  /* ---- 3. Thành phần "trống": median theo tần số + mặt nạ,
          rồi flux theo dải cho cả hai bản (trống / gốc) ---- */

  const fluxP = BANDS.map(() => new Float32Array(nFrames));
  const fluxM = BANDS.map(() => new Float32Array(nFrames));

  const rowPerc = new Float32Array(bins);
  const sortedF = new Float32Array(HPSS.freqHalf * 2 + 1);
  const crossover = Math.max(2, Math.ceil(HPSS.lowCutHz / binHz));

  let prevP = new Float32Array(bins);
  let curP = new Float32Array(bins);
  let prevM = new Float32Array(bins);
  let curM = new Float32Array(bins);

  const scale = 1000;

  for (let f = 0; f < nFrames; f++) {
    const row = mag.subarray(f * bins, (f + 1) * bins);

    if (USE_HPSS) {
      medianFilter1D(row, rowPerc, bins, HPSS.freqHalf, sortedF);

      const base = f * bins;

      for (let k = 0; k < bins; k++) {
        // Dải trầm: kick hẹp theo tần số nên dùng chính biên độ làm "P".
        const p = k < crossover ? row[k] : rowPerc[k];
        const h = harm[base + k];

        const p2 = p * p;
        const mask = p2 / (p2 + h * h + 1e-12);

        curP[k] = Math.log1p(row[k] * mask * scale);
        curM[k] = Math.log1p(row[k] * scale);
      }
    } else {
      for (let k = 0; k < bins; k++) {
        curP[k] = curM[k] = Math.log1p(row[k] * scale);
      }
    }

    if (f > 0) {
      accumulateFlux(curP, prevP, ranges, fluxP, f);
      accumulateFlux(curM, prevM, ranges, fluxM, f);
    }

    let tmp = prevP; prevP = curP; curP = tmp;
    tmp = prevM; prevM = curM; curM = tmp;

    if (f % 200 === 0) {
      report(65 + Math.round((f / nFrames) * 30), "Đang tách nhạc khỏi trống…");
      await nextTick();
    }
  }

  return { percussive: fluxP, mixed: fluxM };
}

// Spectral flux nửa sóng, max-filter khung trước (±1 bin) để bỏ vibrato.
function accumulateFlux(cur, prev, ranges, out, f) {
  for (let b = 0; b < ranges.length; b++) {
    const { lo, hi } = ranges[b];
    let sum = 0;

    for (let k = lo; k <= hi; k++) {
      const pm = Math.max(prev[k - 1], prev[k], prev[k + 1]);
      const d = cur[k] - pm;

      if (d > 0) sum += d;
    }

    out[b][f] = sum / (hi - lo + 1);
  }
}

/* =====================================
   ONSET ENVELOPE
===================================== */

function buildOnsetEnvelope(flux) {
  const n = flux[0].length;
  const env = new Float32Array(n);

  const means = flux.map(arr => {
    let s = 0;
    for (let i = 0; i < n; i++) s += arr[i];
    return s / Math.max(1, n);
  });

  const globalMean =
    means.reduce((a, b) => a + b, 0) / means.length;

  // Mỗi dải chuẩn hoá theo mức trung bình của chính nó.
  const bands = flux.map((arr, b) => {
    const denom = Math.max(means[b], globalMean * 0.1, 1e-9);
    const norm = new Float32Array(n);

    for (let i = 0; i < n; i++) norm[i] = arr[i] / denom;

    return norm;
  });

  for (let b = 0; b < BANDS.length; b++) {
    const w = BANDS[b].weight;

    for (let i = 0; i < n; i++) env[i] += bands[b][i] * w;
  }

  // Trừ xu hướng nền (trung bình trượt ~0.6 s), giữ phần dương.
  const radius = Math.max(2, Math.round(0.3 / (HOP / TARGET_SR)));
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

    // Năng lượng từng dải quanh đỉnh → dùng để nhận diện loại trống.
    let l = 0;
    let m = 0;
    let h = 0;

    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) {
      l = Math.max(l, bands[0][j]);
      m = Math.max(m, bands[1][j]);
      h = Math.max(h, bands[2][j]);
    }

    onsets.push({
      time: parabolic(env, i) * frameDur,
      strength: v,
      low: l,
      mid: m,
      high: h,
      type: "perc"
    });
  }

  for (const o of onsets) o.type = classifyOnset(o.low, o.mid, o.high);

  return onsets;
}

function classifyOnset(l, m, h) {
  // Dùng tỉ lệ giữa các dải (không phụ thuộc âm lượng bài):
  //   kick  : trầm áp đảo (kể cả khi trùng hi-hat)
  //   hat   : cao áp đảo
  //   tone  : chỉ có dải giữa, gần như không có dải cao (nốt giai điệu rò)
  //   snare : nhiễu dải rộng, dải giữa + dải cao
  const eps = 1e-9;
  const lowRatio = l / (m + h + eps);
  const highRatio = h / (l + m + eps);
  const midOverHigh = m / (h + eps);

  if (lowRatio >= 0.6) return "kick";
  if (highRatio >= 1.2) return "hat";
  if (midOverHigh >= 8 && lowRatio < 0.3) return "tone";
  if (highRatio >= 0.35) return "snare";

  return "perc";
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
      const base = 0.35 * S + 0.25 * 0.4 + 0.25 * 0.4;

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
    if (nearestOnset(t, 0.06) >= 0) supported++;
    else unsupportedBeats.push(t);
  }

  const support = supported / beats.length;

  reliability = Math.round(100 * support * (0.4 + 0.6 * regular));

  // ---- Lưới nhịp mở rộng ra hai đầu bài ----
  const { grid } = extendGrid(beats, duration);

  // ---- Downbeat (phách 1) – ước lượng bằng kick/snare ----
  const kickSum = [0, 0, 0, 0];
  const snareSum = [0, 0, 0, 0];
  const phaseCount = [0, 0, 0, 0];

  for (let i = 0; i < grid.length; i++) {
    const j = nearestOnset(grid[i], 0.06);
    const ph = i % 4;

    phaseCount[ph]++;

    if (j >= 0) {
      kickSum[ph] += onsets[j].low;
      snareSum[ph] += onsets[j].mid;
    }
  }

  const avg = (arr, p) => arr[p] / Math.max(1, phaseCount[p]);

  let downPhase = 0;
  let downBest = -Infinity;

  for (let p = 0; p < 4; p++) {
    const score =
      avg(kickSum, p) +
      0.5 * (avg(snareSum, (p + 1) % 4) + avg(snareSum, (p + 3) % 4)) -
      0.5 * (avg(snareSum, p) + avg(snareSum, (p + 2) % 4));

    if (score > downBest) {
      downBest = score;
      downPhase = p;
    }
  }

  // ---- Vị trí từng onset trên ô nhịp (16 khe / bar) ----
  const classIndex = { kick: 0, snare: 1, hat: 2, perc: 3, tone: 4 };
  const occupancy = [0, 1, 2, 3, 4].map(() => new Float32Array(16));

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

    if (o.slotError < 0.5) {
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

    if (o.slot >= 0 && o.slotError < 0.5) {
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

    // Độ mạnh quyết định chính; lưới nhịp và tính lặp chỉ cộng/trừ thêm.
    const base = 0.5 * S + 0.25 * G + 0.2 * R + bonus;
    const importance = Math.min(1, base * (0.45 + 0.55 * T));

    result.push(makeCandidate(o.time, importance, o.type));
  }

  // Beat của lưới mà không có cú đập thật: vẫn giữ nếu lưới đáng tin.
  const gridImportance = support >= 0.5 ? 0.52 : 0.2;

  for (const t of unsupportedBeats) {
    result.push(makeCandidate(t, gridImportance, "grid"));
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
   LƯỚI NHỊP CỨNG (cho bài đều nhịp)
===================================== */

/*
  Quy hoạch động bám theo từng cú đập nên lưới có thể dao động ±10% và
  lệch BPM vài phần trăm. Với bài làm bằng máy (nhịp đều), ta tìm chu kỳ
  nửa phách + pha làm cho các cú đập mạnh "đồng pha" nhất (tổng vector
  có trọng số), rồi dựng lưới đều tăm tắp từ đó. Nếu mức đồng pha thấp
  (nhạc sống, tempo thay đổi) thì trả về null và giữ lưới cũ.
*/
function fitRigidGrid(onsets, duration, tempo, frameDur) {
  if (!tempo || onsets.length < 12) return null;

  const quarter = tempo.period * frameDur;
  const half = quarter / 2;

  const sortedStrength = onsets.map(o => o.strength).sort((a, b) => a - b);
  const minStrength = sortedStrength[Math.floor(sortedStrength.length * 0.4)];

  const pts = onsets.filter(
    o => o.strength >= minStrength && o.type !== "hat" && o.type !== "tone"
  );

  if (pts.length < 10) return null;

  let wsum = 0;
  for (const p of pts) wsum += p.strength;

  const coherence = period => {
    let re = 0;
    let im = 0;

    for (const p of pts) {
      const a = (2 * Math.PI * p.time) / period;

      re += p.strength * Math.cos(a);
      im += p.strength * Math.sin(a);
    }

    return { score: Math.hypot(re, im) / wsum, phase: Math.atan2(im, re) };
  };

  let best = null;
  let bestPeriod = 0;

  for (let P = half * 0.95; P <= half * 1.05; P += 0.00005) {
    const c = coherence(P);

    if (!best || c.score > best.score) {
      best = c;
      bestPeriod = P;
    }
  }

  if (!best || best.score < 0.6) return null;

  // Hai pha ứng viên cho phách (cách nhau nửa phách): chọn pha có nhiều kick hơn.
  const Q = bestPeriod * 2;
  const phase0 = (best.phase / (2 * Math.PI)) * bestPeriod;

  const kickOn = phase => {
    let sum = 0;

    for (const o of onsets) {
      let d = (o.time - phase) % Q;

      if (d < 0) d += Q;
      if (d > Q / 2) d -= Q;

      if (Math.abs(d) < 0.03) sum += o.low;
    }

    return sum;
  };

  const phase = kickOn(phase0) >= kickOn(phase0 + bestPeriod)
    ? phase0
    : phase0 + bestPeriod;

  const first = Math.min(...pts.map(p => p.time)) - Q / 2;
  const last = Math.max(...pts.map(p => p.time)) + Q / 2;

  let t = phase + Math.ceil((Math.max(0, first) - phase) / Q) * Q;

  const beats = [];

  for (; t <= Math.min(duration, last); t += Q) beats.push(t);

  if (beats.length < 4) return null;

  return { beats, bpm: 60 / Q, score: best.score };
}

/* =====================================
   CĂN CHỈNH THỜI ĐIỂM THEO DẠNG SÓNG
===================================== */

/*
  Thời điểm từ STFT chỉ chính xác cỡ một khung (~12 ms). Ở đây ta nhìn
  lại dạng sóng quanh điểm đó: tính đường bao biên độ (cửa sổ ~3 ms),
  tìm đỉnh gần nhất rồi lùi về chỗ đường bao bắt đầu bật lên khỏi nền.
  Kick dùng tín hiệu gốc (năng lượng ở tần số thấp); các loại khác dùng
  đạo hàm bậc nhất để nhấn mạnh phần "tấn công".
*/
const REFINE = {
  back: 0.045,     // s: nhìn lùi để tìm nền trước cú đập
  peakBack: 0.025, // s: đỉnh phải nằm trong [t - 25 ms, t + 30 ms]
  peakFwd: 0.03,
  smooth: 0.0015,  // s: nửa độ rộng cửa sổ làm mượt
  riseLevel: 0.2   // điểm bắt đầu = nền + 20% (đỉnh - nền)
};

function refineOnsetTime(mono, sampleRate, time, type) {
  const c = Math.round(time * sampleRate);
  const a0 = Math.max(1, c - Math.round(REFINE.back * sampleRate));
  const a1 = Math.min(mono.length - 1, c + Math.round(REFINE.peakFwd * sampleRate));
  const sm = Math.max(4, Math.round(REFINE.smooth * sampleRate));
  const len = a1 - a0 + 1;

  if (len < sm * 6) return time;

  const useDiff = type !== "kick";
  const prefix = new Float64Array(len + 1);

  for (let i = 0; i < len; i++) {
    const k = a0 + i;
    const v = useDiff ? mono[k] - mono[k - 1] : mono[k];

    prefix[i + 1] = prefix[i] + v * v;
  }

  const env = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    const a = Math.max(0, i - sm);
    const b = Math.min(len - 1, i + sm);

    env[i] = Math.sqrt((prefix[b + 1] - prefix[a]) / (b - a + 1));
  }

  const lo = Math.max(0, c - a0 - Math.round(REFINE.peakBack * sampleRate));

  let pk = lo;

  for (let i = lo; i < len; i++) {
    if (env[i] > env[pk]) pk = i;
  }

  let base = Infinity;

  for (let i = 0; i <= pk; i++) {
    if (env[i] < base) base = env[i];
  }

  const peak = env[pk];

  // Đỉnh phải nổi rõ so với nền, nếu không giữ nguyên thời điểm cũ.
  if (peak < 1e-4 || peak < 1.6 * base) return time;

  const level = base + REFINE.riseLevel * (peak - base);

  let k = pk;

  while (k > 0 && env[k] > level) k--;

  const span = env[k + 1] - env[k];
  const frac = span > 1e-12 ? (level - env[k]) / span : 0;

  return (a0 + k + Math.max(0, Math.min(1, frac))) / sampleRate;
}

/* =====================================
   NĂNG LƯỢNG RMS (DÙNG ĐỂ VẼ)
===================================== */

function calculateEnergy(signal, hop) {
  const result = [];

  for (let start = 0; start < signal.length; start += hop) {
    let sum = 0;

    const end = Math.min(start + hop, signal.length);

    for (let i = start; i < end; i++) {
      sum += signal[i] * signal[i];
    }

    result.push(
      Math.sqrt(sum / Math.max(1, end - start))
    );
  }

  return result;
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
  if (!audioBuffer) return;

  const rect = canvas.getBoundingClientRect();
  const duration = audioBuffer.duration;
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
  if (!audioBuffer) return;

  const rect = canvas.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;

  videoPlayer.currentTime =
    Math.max(0, Math.min(1, ratio)) * audioBuffer.duration;
});

/* =====================================
   NGHE THỬ MARKER BẰNG TIẾNG CLICK
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

  const duration = audioBuffer?.duration || 1;

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

  if (audioBuffer && videoPlayer.currentTime > 0) {
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
  if (audioBuffer) drawWaveform();
});
