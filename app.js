
const fileInput = document.getElementById("audioFile");
const audioPlayer = document.getElementById("audioPlayer");
const analyzeBtn = document.getElementById("analyzeBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const fileInfo = document.getElementById("fileInfo");
const canvas = document.getElementById("waveform");
const ctx = canvas.getContext("2d");

let audioBuffer = null;
let markerSeconds = [];
let selectedName = "audio";
let analysisData = null;

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];

  if (!file) return;

  selectedName =
    file.name.replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9_-]/gi, "_") || "audio";

  fileInfo.textContent =
    `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;

  audioPlayer.src = URL.createObjectURL(file);
  audioPlayer.hidden = false;

  analyzeBtn.disabled = true;
  downloadBtn.disabled = true;

  markerSeconds = [];
  audioBuffer = null;
  analysisData = null;

  clearStats();

  statusEl.textContent = "Đang đọc âm thanh…";

  try {
    const bytes = await file.arrayBuffer();

    const AudioCtx =
      window.AudioContext || window.webkitAudioContext;

    const audioContext = new AudioCtx();

    audioBuffer = await audioContext.decodeAudioData(bytes);

    await audioContext.close();

    analyzeBtn.disabled = false;

    statusEl.textContent =
      "Đã sẵn sàng. Nhấn Phân tích nhịp.";

    document.getElementById("duration").textContent =
      formatTime(audioBuffer.duration);

    drawWaveform([]);

  } catch (error) {
    console.error(error);

    statusEl.textContent =
      "Không đọc được file. Hãy thử MP3 hoặc WAV khác.";
  }
});

analyzeBtn.addEventListener("click", async () => {
  if (!audioBuffer) return;

  analyzeBtn.disabled = true;
  downloadBtn.disabled = true;

  statusEl.textContent =
    "Đang phân tích các dải tần và tìm nhịp trống…";

  // Cho trình duyệt cập nhật giao diện trước khi tính toán.
  await new Promise(resolve => setTimeout(resolve, 50));

  try {
    analysisData = detectDrumBeats(
      audioBuffer,
      document.getElementById("sensitivity").value
    );

    markerSeconds = analysisData.times;

    document.getElementById("bpm").textContent =
      analysisData.bpm
        ? Math.round(analysisData.bpm)
        : "—";

    document.getElementById("markers").textContent =
      markerSeconds.length;

    document.getElementById("beatCount").textContent =
      `${markerSeconds.length} marker`;

    drawWaveform(
      analysisData.envelope,
      markerSeconds,
      audioBuffer.duration
    );

    downloadBtn.disabled =
      markerSeconds.length === 0;

    statusEl.textContent =
      markerSeconds.length
        ? "Hoàn tất! Hãy nghe thử các marker trước khi xuất XML."
        : "Chưa tìm được beat rõ ràng. Hãy thử độ nhạy cao hơn.";

  } catch (error) {
    console.error(error);

    statusEl.textContent =
      "Lỗi trong quá trình phân tích.";
  }

  analyzeBtn.disabled = false;
});

/* =====================================
   PHÂN TÍCH BEAT
===================================== */

function detectDrumBeats(buffer, sensitivity) {
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;

  const left = buffer.getChannelData(0);

  const right =
    buffer.numberOfChannels > 1
      ? buffer.getChannelData(1)
      : left;

  // Chuyển âm thanh stereo thành mono.
  const mono = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    mono[i] = (left[i] + right[i]) * 0.5;
  }

  /*
    Chia tín hiệu thành ba dải:

    LOW:  kick và bass
    MID:  snare và thân trống
    HIGH: hi-hat và transient sáng
  */

  const low = createBandSignal(
    mono,
    sampleRate,
    40,
    160
  );

  const mid = createBandSignal(
    mono,
    sampleRate,
    160,
    2500
  );

  const high = createBandSignal(
    mono,
    sampleRate,
    2500,
    11000
  );

  const hop = 512;

  const lowEnergy = calculateEnergy(low, hop);
  const midEnergy = calculateEnergy(mid, hop);
  const highEnergy = calculateEnergy(high, hop);

  const lowFlux = calculateFlux(lowEnergy);
  const midFlux = calculateFlux(midEnergy);
  const highFlux = calculateFlux(highEnergy);

  /*
    Trọng số:

    Kick có trọng số cao nhất.
    Snare và hi-hat hỗ trợ xác nhận nhịp.
  */

  const combined = lowFlux.map((_, i) =>
    lowFlux[i] * 1.5 +
    midFlux[i] * 1.0 +
    highFlux[i] * 0.65
  );

  const smooth = smoothSignal(combined, 3);

  const sensitivityConfig = {
    low: {
      threshold: 2.5,
      minGap: 0.42
    },

    medium: {
      threshold: 1.8,
      minGap: 0.30
    },

    high: {
      threshold: 1.35,
      minGap: 0.22
    }
  };

  const config =
    sensitivityConfig[sensitivity] ||
    sensitivityConfig.medium;

  const times = [];
  const strengths = [];

  const windowRadius = 20;

  for (let i = 3; i < smooth.length - 3; i++) {
    let sum = 0;
    let count = 0;

    for (
      let j = Math.max(0, i - windowRadius);
      j <= Math.min(
        smooth.length - 1,
        i + windowRadius
      );
      j++
    ) {
      sum += smooth[j];
      count++;
    }

    const average = sum / count;

    const threshold =
      average * config.threshold;

    const isPeak =
      smooth[i] > threshold &&
      smooth[i] >= smooth[i - 1] &&
      smooth[i] > smooth[i + 1];

    if (!isPeak) continue;

    const time = (i * hop) / sampleRate;

    const strength = smooth[i];

    if (
      !times.length ||
      time - times[times.length - 1] >= config.minGap
    ) {
      times.push(time);
      strengths.push(strength);
    } else {
      // Nếu hai marker gần nhau, giữ marker mạnh hơn.
      const last = strengths.length - 1;

      if (strength > strengths[last]) {
        times[last] = time;
        strengths[last] = strength;
      }
    }
  }

  const bpm = estimateBPM(times);

  return {
    times,
    bpm,
    envelope: calculateEnergy(mono, hop)
  };
}

/* =====================================
   LỌC DẢI TẦN
===================================== */

function createBandSignal(
  input,
  sampleRate,
  lowCut,
  highCut
) {
  const output = new Float32Array(input.length);

  const dt = 1 / sampleRate;

  const rcHigh =
    1 / (2 * Math.PI * lowCut);

  const rcLow =
    1 / (2 * Math.PI * highCut);

  const alphaHigh =
    rcHigh / (rcHigh + dt);

  const alphaLow =
    dt / (rcLow + dt);

  let previousInput = 0;
  let previousHigh = 0;
  let lowPass = 0;

  for (let i = 0; i < input.length; i++) {
    const value = input[i];

    const highPass =
      alphaHigh *
      (previousHigh + value - previousInput);

    previousInput = value;
    previousHigh = highPass;

    lowPass += alphaLow * (highPass - lowPass);

    output[i] = lowPass;
  }

  return output;
}

/* =====================================
   NĂNG LƯỢNG RMS
===================================== */

function calculateEnergy(signal, hop) {
  const result = [];

  for (
    let start = 0;
    start < signal.length;
    start += hop
  ) {
    let sum = 0;

    const end = Math.min(
      start + hop,
      signal.length
    );

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
   ENERGY FLUX
===================================== */

function calculateFlux(energy) {
  return energy.map((value, i) =>
    Math.max(
      0,
      value - (energy[i - 1] || 0)
    )
  );
}

/* =====================================
   LÀM MƯỢT
===================================== */

function smoothSignal(data, radius) {
  return data.map((_, i) => {
    let sum = 0;
    let count = 0;

    for (
      let j = Math.max(0, i - radius);
      j <= Math.min(
        data.length - 1,
        i + radius
      );
      j++
    ) {
      sum += data[j];
      count++;
    }

    return sum / count;
  });
}

/* =====================================
   ƯỚC TÍNH BPM
===================================== */

function estimateBPM(times) {
  const intervals = [];

  for (let i = 1; i < times.length; i++) {
    const interval =
      times[i] - times[i - 1];

    if (interval >= 0.25 && interval <= 1.5) {
      intervals.push(interval);
    }
  }

  if (!intervals.length) return 0;

  const sorted = [...intervals].sort(
    (a, b) => a - b
  );

  const middle =
    Math.floor(sorted.length / 2);

  const median =
    sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;

  return 60 / median;
}

/* =====================================
   XUẤT XML ALIGHT MOTION
===================================== */

downloadBtn.addEventListener("click", () => {
  if (!markerSeconds.length) return;

  const fps = Number(
    document.getElementById("fps").value
  );

  const width = Number(
    document.getElementById("width").value
  );

  const height = Number(
    document.getElementById("height").value
  );

  /*
    Lưu ý:
    Đơn vị thời gian bookmark hiện được giả định là ms.
    Cần thử nhập XML trong Alight Motion để xác nhận.
  */

  const bookmarks = markerSeconds
    .map(seconds =>
      `  <bookmark t="${Math.round(seconds * 1000)}" />`
    )
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
  link.download =
    `${selectedName}_beat_markers.xml`;

  link.click();

  URL.revokeObjectURL(url);
});

/* =====================================
   VẼ BIỂU ĐỒ
===================================== */

function drawWaveform(
  envelope,
  markers = [],
  duration = audioBuffer?.duration || 1
) {
  const dpr = window.devicePixelRatio || 1;

  const width = Math.max(
    300,
    canvas.clientWidth
  );

  const height = 120;

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (!envelope.length) {
    ctx.strokeStyle = "#29334b";
    ctx.beginPath();
    ctx.moveTo(0, 60);
    ctx.lineTo(width, 60);
    ctx.stroke();
    return;
  }

  const step = Math.max(
    1,
    Math.floor(envelope.length / width)
  );

  const max = Math.max(...envelope) || 1;

  ctx.strokeStyle = "#51d9d0";
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = 0; x < width; x++) {
    const value =
      envelope[
        Math.min(
          envelope.length - 1,
          x * step
        )
      ] / max;

    const h = Math.max(2, value * 50);

    ctx.moveTo(x, 60 - h);
    ctx.lineTo(x, 60 + h);
  }

  ctx.stroke();

  ctx.strokeStyle = "#ff668e";
  ctx.lineWidth = 1;

  markers.forEach(time => {
    const x = (time / duration) * width;

    ctx.beginPath();
    ctx.moveTo(x, 5);
    ctx.lineTo(x, 115);
    ctx.stroke();
  });
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

  drawWaveform([]);
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
  if (audioBuffer) {
    drawWaveform(
      analysisData?.envelope || [],
      markerSeconds,
      audioBuffer.duration
    );
  }
});
    
