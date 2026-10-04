"use strict";

/* =====================================================
   TA MOTION · BEAT MARKER  (phiên bản nâng cấp)

   Thuật toán:
   1. STFT + log-magnitude spectral flux (kiểu SuperFlux) cho 3 dải
      LOW (kick/bass), MID (snare), HIGH (hi-hat).
   2. Gộp dải có cân bằng, loại bỏ xu hướng nền → onset envelope.
   3. Ước tính tempo bằng autocorrelation + prior tempo.
   4. Dò beat bằng quy hoạch động (Ellis 2007) → nhịp đều, ổn định.
   5. Dò onset cục bộ (ngưỡng thích nghi mean + k·std) để bắt thêm
      các cú trống ngoài beat, tuỳ theo độ nhạy.
   6. Snap marker theo khung hình (fps) khi xuất XML.
===================================================== */

const fileInput = document.getElementById("audioFile");
const audioPlayer = document.getElementById("audioPlayer");
const analyzeBtn = document.getElementById("analyzeBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const fileInfo = document.getElementById("fileInfo");
const canvas = document.getElementById("waveform");
const ctx = canvas.getContext("2d");

let audioBuffer = null;
let selectedName = "audio";
let analysisData = null;
let analysisToken = 0;
let objectUrl = null;

// Marker: beat (nhịp chính) + extra (cú trống thêm / marker thủ công).
let beatTimes = [];
let extraTimes = [];
let markerSeconds = [];
let beatSet = new Set();

const FFT_SIZE = 2048;

const BANDS = [
  { name: "low", lo: 40, hi: 160, weight: 1.4 },
  { name: "mid", lo: 160, hi: 2500, weight: 1.0 },
  { name: "high", lo: 2500, hi: 11000, weight: 0.6 }
];

/*
  low    : chỉ các beat chính (đều và sạch nhất)
  medium : beat + các cú trống rơi vào nửa nhịp (nốt móc đơn)
  high   : beat + mọi cú trống mạnh
*/
const SENSITIVITY = {
  low: { k: 1.6, mode: "beats", fallbackGap: 0.42 },
  medium: { k: 1.0, mode: "grid", fallbackGap: 0.30 },
  high: { k: 0.5, mode: "all", fallbackGap: 0.22 }
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
      .replace(/[^a-z0-9_-]/gi, "_") || "audio";

  fileInfo.textContent =
    `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);

  audioPlayer.src = objectUrl;
  audioPlayer.hidden = false;

  analyzeBtn.disabled = true;
  downloadBtn.disabled = true;

  beatTimes = [];
  extraTimes = [];
  markerSeconds = [];
  beatSet = new Set();
  audioBuffer = null;
  analysisData = null;

  clearStats();

  statusEl.textContent = "Đang đọc âm thanh…";

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
      "Không đọc được file. Hãy thử MP3 hoặc WAV khác.";
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

  statusEl.textContent =
    "Đang phân tích các dải tần và tìm nhịp trống…";

  await nextTick();

  try {
    const result = await detectDrumBeats(
      buffer,
      document.getElementById("sensitivity").value,
      percent => {
        if (token === analysisToken) {
          statusEl.textContent =
            `Đang phân tích nhịp trống… ${percent}%`;
        }
      }
    );

    if (token !== analysisToken) return;

    analysisData = result;
    beatTimes = result.beats;
    extraTimes = result.extras;

    document.getElementById("bpm").textContent =
      result.bpm ? Math.round(result.bpm) : "—";

    setEnvelope(result.envelope);
    rebuildMarkerList();

    statusEl.textContent =
      markerSeconds.length
        ? "Hoàn tất! Bật nghe thử bằng tiếng click, nhấp đúp lên sóng để thêm/xóa marker."
        : "Chưa tìm được beat rõ ràng. Hãy thử độ nhạy cao hơn.";

  } catch (error) {
    console.error(error);

    if (token === analysisToken) {
      statusEl.textContent = "Lỗi trong quá trình phân tích.";
    }
  }

  if (token === analysisToken) analyzeBtn.disabled = false;
});

/* =====================================
   PIPELINE CHÍNH
===================================== */

async function detectDrumBeats(buffer, sensitivity, onProgress) {
  const sampleRate = buffer.sampleRate;
  const hop = sampleRate > 48000 ? 1024 : 512;
  const frameDur = hop / sampleRate;

  const mono = toMono(buffer);

  const flux = await computeBandFlux(
    mono,
    sampleRate,
    hop,
    onProgress
  );

  const env = buildOnsetEnvelope(flux, frameDur);

  const tempo = estimateTempo(env, frameDur);

  let beats = [];
  let bpm = 0;
  let periodSec = 0.5;

  if (tempo) {
    const frames = trimBeats(
      trackBeats(env, tempo.period),
      env
    );

    beats = refineBeats(frames, env, hop, sampleRate, tempo.period);

    if (beats.length >= 4) {
      const intervals = [];

      for (let i = 1; i < beats.length; i++) {
        intervals.push(beats[i] - beats[i - 1]);
      }

      periodSec = median(intervals);
      bpm = 60 / periodSec;
    } else {
      bpm = tempo.bpm;
      periodSec = 60 / tempo.bpm;
    }
  }

  const config =
    SENSITIVITY[sensitivity] || SENSITIVITY.medium;

  const onsets = pickOnsets(env, frameDur, config.k);

  const markers = buildMarkers(
    beats,
    onsets,
    periodSec,
    config
  );

  return {
    beats: markers.beats,
    extras: markers.extras,
    bpm,
    confidence: tempo ? tempo.confidence : 0,
    envelope: calculateEnergy(mono, hop)
  };
}

function toMono(buffer) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const mono = new Float32Array(length);

  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);

    for (let i = 0; i < length; i++) {
      mono[i] += data[i];
    }
  }

  if (channels > 1) {
    for (let i = 0; i < length; i++) {
      mono[i] /= channels;
    }
  }

  return mono;
}

/* =====================================
   FFT + SPECTRAL FLUX THEO DẢI
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

async function computeBandFlux(mono, sampleRate, hop, onProgress) {
  const N = FFT_SIZE;
  const half = N / 2;
  const fft = createFFT(N);

  const win = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  }

  const nFrames = Math.floor(mono.length / hop) + 1;
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

  const flux = BANDS.map(() => new Float32Array(nFrames));

  const re = new Float32Array(N);
  const im = new Float32Array(N);

  let prev = new Float32Array(half + 1);
  let cur = new Float32Array(half + 1);

  // Biên độ sin đủ mức → mag ≈ N/4. Chuẩn hoá rồi nén log.
  const scale = 1000 / (N / 4);

  for (let f = 0; f < nFrames; f++) {
    const start = f * hop - half;

    for (let i = 0; i < N; i++) {
      const idx = start + i;

      re[i] =
        idx >= 0 && idx < mono.length
          ? mono[idx] * win[i]
          : 0;

      im[i] = 0;
    }

    fft(re, im);

    for (let k = 0; k <= half; k++) {
      cur[k] = Math.log1p(
        Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale
      );
    }

    if (f > 0) {
      for (let b = 0; b < ranges.length; b++) {
        const { lo, hi } = ranges[b];
        let sum = 0;

        for (let k = lo; k <= hi; k++) {
          // Max-filter khung trước (±1 bin) để bỏ qua rung/vibrato.
          const pm = Math.max(
            prev[k - 1],
            prev[k],
            prev[k + 1]
          );

          const d = cur[k] - pm;

          if (d > 0) sum += d;
        }

        flux[b][f] = sum / (hi - lo + 1);
      }
    }

    const tmp = prev;
    prev = cur;
    cur = tmp;

    if (f % 200 === 0) {
      if (onProgress) {
        onProgress(Math.round((f / nFrames) * 100));
      }

      await nextTick();
    }
  }

  return flux;
}

/* =====================================
   ONSET ENVELOPE
===================================== */

function buildOnsetEnvelope(flux, frameDur) {
  const n = flux[0].length;
  const env = new Float32Array(n);

  const means = flux.map(arr => {
    let s = 0;
    for (let i = 0; i < n; i++) s += arr[i];
    return s / Math.max(1, n);
  });

  const globalMean =
    means.reduce((a, b) => a + b, 0) / means.length;

  // Cân bằng từng dải theo mức trung bình của chính nó.
  BANDS.forEach((band, b) => {
    const denom = Math.max(means[b], globalMean * 0.1, 1e-9);
    const gain = band.weight / denom;
    const arr = flux[b];

    for (let i = 0; i < n; i++) {
      env[i] += arr[i] * gain;
    }
  });

  // Trừ xu hướng nền (trung bình trượt ~0.6 giây), chỉ giữ phần dương.
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

  // Làm mượt nhẹ 3 điểm.
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    out[i] =
      0.25 * (detrended[i - 1] || 0) +
      0.5 * detrended[i] +
      0.25 * (detrended[i + 1] || 0);
  }

  // Chuẩn hoá theo độ lệch chuẩn.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= Math.max(1, n);

  let variance = 0;
  for (let i = 0; i < n; i++) {
    variance += (out[i] - mean) * (out[i] - mean);
  }

  const std = Math.sqrt(variance / Math.max(1, n)) || 1;

  for (let i = 0; i < n; i++) out[i] /= std;

  return out;
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

    // Ưu tiên vùng tempo phổ biến (~118 BPM, rộng ~1 octave).
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

  // Làm mượt cục bộ bằng cửa sổ Gauss nhỏ.
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

  // Beat cuối: đỉnh cục bộ cuối cùng của cum đủ lớn.
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

// Bỏ các beat yếu ở đầu/cuối bài (khoảng lặng, intro, outro).
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

// Căn beat vào đỉnh onset gần nhất, nội suy dưới mức khung hình.
function refineBeats(frames, env, hop, sampleRate, period) {
  const times = [];
  const minSpacing = (period * hop / sampleRate) * 0.4;

  for (const frame of frames) {
    let best = frame;

    for (let j = frame - 2; j <= frame + 2; j++) {
      if (j >= 0 && j < env.length && env[j] > env[best]) best = j;
    }

    const t = (parabolic(env, best) * hop) / sampleRate;

    if (!times.length || t - times[times.length - 1] >= minSpacing) {
      times.push(t);
    }
  }

  return times;
}

/* =====================================
   DÒ ONSET (CÚ TRỐNG NGOÀI BEAT)
===================================== */

function pickOnsets(env, frameDur, k) {
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

    onsets.push({
      time: parabolic(env, i) * frameDur,
      strength: v
    });
  }

  return onsets;
}

/* =====================================
   GHÉP BEAT + ONSET THEO ĐỘ NHẠY
===================================== */

function buildMarkers(beats, onsets, periodSec, config) {
  const haveGrid = beats.length >= 4;

  const accepted = haveGrid ? beats.slice() : [];
  const extras = [];

  if (haveGrid && config.mode === "beats") {
    return { beats: accepted, extras };
  }

  const nearestDistance = t => {
    if (!accepted.length) return Infinity;

    const i = lowerBound(accepted, t);
    let d = Infinity;

    if (i < accepted.length) d = Math.min(d, accepted[i] - t);
    if (i > 0) d = Math.min(d, t - accepted[i - 1]);

    return d;
  };

  const insert = t => {
    accepted.splice(lowerBound(accepted, t), 0, t);
    extras.push(t);
  };

  const isHalfBeat = t => {
    const j = lowerBound(beats, t) - 1;

    if (j < 0 || j >= beats.length - 1) return false;

    const interval = beats[j + 1] - beats[j];
    const phase = (t - beats[j]) / interval;

    return Math.abs(phase - 0.5) < 0.14;
  };

  // Cú mạnh nhất được ưu tiên khi hai ứng viên quá gần nhau.
  const sorted = onsets.slice().sort((a, b) => b.strength - a.strength);

  for (const onset of sorted) {
    let minGap;

    if (!haveGrid) {
      minGap = config.fallbackGap;
    } else if (config.mode === "grid") {
      if (!isHalfBeat(onset.time)) continue;
      minGap = periodSec * 0.3;
    } else {
      minGap = Math.max(0.09, periodSec * 0.2);
    }

    if (nearestDistance(onset.time) >= minGap) {
      insert(onset.time);
    }
  }

  extras.sort((a, b) => a - b);

  return {
    beats: haveGrid ? beats.slice() : [],
    extras
  };
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

// Nội suy parabol quanh đỉnh để có độ chính xác dưới 1 mẫu.
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

function rebuildMarkerList() {
  markerSeconds = [...beatTimes, ...extraTimes]
    .sort((a, b) => a - b);

  beatSet = new Set(beatTimes);

  document.getElementById("markers").textContent =
    markerSeconds.length;

  document.getElementById("beatCount").textContent =
    `${markerSeconds.length} marker`;

  downloadBtn.disabled = markerSeconds.length === 0;

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

  let nearest = -1;
  let nearestDist = Infinity;

  markerSeconds.forEach((t, i) => {
    const d = Math.abs(t - time);

    if (d < nearestDist) {
      nearestDist = d;
      nearest = i;
    }
  });

  if (nearest >= 0 && nearestDist <= tolerance) {
    const target = markerSeconds[nearest];

    beatTimes = beatTimes.filter(t => t !== target);
    extraTimes = extraTimes.filter(t => t !== target);
  } else {
    extraTimes.push(Math.max(0, Math.min(duration, time)));
  }

  rebuildMarkerList();
});

// Nhấp một lần: tua tới vị trí đó.
canvas.addEventListener("click", event => {
  if (!audioBuffer) return;

  const rect = canvas.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;

  audioPlayer.currentTime =
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
  clickIndex = lowerBound(markerSeconds, audioPlayer.currentTime);
}

function previewLoop() {
  const now = audioPlayer.currentTime;

  if (clickToggle.checked && !audioPlayer.paused && clickContext) {
    const lookahead = 0.05;

    while (
      clickIndex < markerSeconds.length &&
      markerSeconds[clickIndex] <= now + lookahead
    ) {
      const t = markerSeconds[clickIndex];

      if (t > now - 0.08) {
        playClick(beatSet.has(t), t - now);
      }

      clickIndex++;
    }
  }

  drawWaveform();

  if (!audioPlayer.paused) {
    rafId = requestAnimationFrame(previewLoop);
  }
}

audioPlayer.addEventListener("play", () => {
  if (clickToggle.checked) ensureClickContext();

  resetClickCursor();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(previewLoop);
});

audioPlayer.addEventListener("pause", () => {
  cancelAnimationFrame(rafId);
  drawWaveform();
});

audioPlayer.addEventListener("ended", () => {
  cancelAnimationFrame(rafId);
  drawWaveform();
});

audioPlayer.addEventListener("seeked", () => {
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

  // Mỗi cột pixel lấy giá trị lớn nhất của đoạn tương ứng.
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

  // Beat chính: hồng, cao. Cú trống thêm / thủ công: cam, ngắn hơn.
  for (const time of markerSeconds) {
    const x = (time / duration) * width;
    const strong = beatSet.has(time);

    ctx.strokeStyle = strong ? "#ff668e" : "#ffb347";
    ctx.lineWidth = strong ? 1.5 : 1;

    ctx.beginPath();
    ctx.moveTo(x, strong ? 5 : 25);
    ctx.lineTo(x, strong ? 115 : 95);
    ctx.stroke();
  }

  // Vạch phát hiện tại.
  if (audioBuffer && audioPlayer.currentTime > 0) {
    const x = (audioPlayer.currentTime / duration) * width;

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
