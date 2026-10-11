// 纯 JS 二维码编码器（自包含 · 零依赖 · 不引 npm · 不联网）
//
// 用途：把后端 /code/generate 返回的 qrPayload（形如 kcsq://code/CD00000001）
//      编码成"模块矩阵"，页面再用 canvas 画出来（见 pages/index/index.js）。
//      —— 小程序端不能依赖任何二维码 npm 包，也不能请求图片，所以前端自己编码。
//
// 能力：字节模式（UTF-8，中文安全）· 纠错等级 L/M/Q/H · 版本 1–10（按内容自动选版本）
// 用法：
//   var qrcode = require('../../utils/qrcode.js');
//   var qr = qrcode.encode('kcsq://code/CD00000001');   // 默认 L 级
//   qr.size            // 边长（模块数），如 25
//   qr.modules[y][x]   // 1 = 黑，0 = 白
//   qrcode.toText(qr)  // 便于日志/自测打印的字符画
//
// 说明：本文件是小程序与 Node 自测脚本共用的 CommonJS 模块，不依赖 wx / DOM。

/* eslint-disable no-bitwise */

// ---------------------------------------------------------------- GF(256) 有限域
var GF_EXP = [];   // α^i
var GF_LOG = [];   // log_α(i)
(function initGaloisField() {
  var x = 1;
  for (var i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;   // 本原多项式 x^8 + x^4 + x^3 + x^2 + 1
  }
  for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// 生成多项式的缓存（同一纠错码字数只算一次）
var divisorCache = {};
/** 生成 n 次 Reed-Solomon 生成多项式（不含首项 1，系数按次数从高到低） */
function rsDivisor(degree) {
  if (divisorCache[degree]) return divisorCache[degree];
  var result = [];
  for (var i = 0; i < degree - 1; i++) result.push(0);
  result.push(1);
  var root = 1;
  for (var k = 0; k < degree; k++) {
    for (var j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  divisorCache[degree] = result;
  return result;
}

/** 计算数据码字的 RS 纠错码字（多项式除法取余） */
function rsRemainder(data, divisor) {
  var result = [];
  for (var i = 0; i < divisor.length; i++) result.push(0);
  for (var k = 0; k < data.length; k++) {
    var factor = data[k] ^ result[0];
    result.shift();
    result.push(0);
    for (var j = 0; j < divisor.length; j++) result[j] ^= gfMul(divisor[j], factor);
  }
  return result;
}

// ---------------------------------------------------------------- 版本 / 纠错分块表
// 版本 → 纠错等级 → [每块纠错码字数, 组1块数, 组1每块数据码字数, 组2块数, 组2每块数据码字数]
// 表来源：ISO/IEC 18004 的 RS 分块表（版本 1–10，纠错等级 L/M/Q/H）
var RS_BLOCKS = {
  1: { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  2: { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  3: { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  4: { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  5: { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  7: { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  8: { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  9: { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  10: { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
};

var ECC_ORDER = ['L', 'M', 'Q', 'H'];
var ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };   // 格式信息里的纠错指示位
var MAX_VERSION = 10;

/** 该版本/等级下每块的 [纠错码字数, 数据码字数] 列表 */
function blockLayout(version, ecc) {
  var t = RS_BLOCKS[version][ecc];
  var blocks = [];
  var i;
  for (i = 0; i < t[1]; i++) blocks.push([t[0], t[2]]);
  for (i = 0; i < t[3]; i++) blocks.push([t[0], t[4]]);
  return blocks;
}

/** 数据码字总容量 */
function dataCodewordCount(version, ecc) {
  var t = RS_BLOCKS[version][ecc];
  return t[1] * t[2] + t[3] * t[4];
}

/**
 * 该版本可用的「原始模块数」（不含功能图形）
 * 用于自测脚本交叉校验分块表：数据码字 + 纠错码字 必须等于 floor(原始模块数 / 8)
 */
function numRawDataModules(version) {
  var result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    var numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** 总码字数（数据 + 纠错） */
function totalCodewordCount(version) {
  return Math.floor(numRawDataModules(version) / 8);
}

/** 对齐图形中心坐标 */
function alignmentPositions(version) {
  if (version === 1) return [];
  var size = version * 4 + 17;
  var numAlign = Math.floor(version / 7) + 2;
  var step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  var result = [6];
  for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---------------------------------------------------------------- 文本 → UTF-8 字节
function utf8Bytes(text) {
  var s = text === undefined || text === null ? '' : String(text);
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var cp = s.charCodeAt(i);
    // 代理对（emoji 等）合并成一个码点
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      var lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return out;
}

function appendBits(bits, value, length) {
  for (var i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

// ---------------------------------------------------------------- 数据码字 → 交织后的最终码字序列
function buildCodewords(version, ecc, dataBytes) {
  var bits = [];
  appendBits(bits, 0x4, 4);                                       // 模式指示符：字节模式
  appendBits(bits, dataBytes.length, version <= 9 ? 8 : 16);      // 字符计数指示符
  for (var i = 0; i < dataBytes.length; i++) appendBits(bits, dataBytes[i], 8);

  var capacity = dataCodewordCount(version, ecc) * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));       // 终止符
  while (bits.length % 8 !== 0) bits.push(0);                     // 补齐到字节边界
  var pads = [0xec, 0x11];
  for (var p = 0; bits.length < capacity; p++) appendBits(bits, pads[p % 2], 8);

  var dataCodewords = [];
  for (var b = 0; b < bits.length; b += 8) {
    var byteVal = 0;
    for (var k = 0; k < 8; k++) byteVal = (byteVal << 1) | bits[b + k];
    dataCodewords.push(byteVal);
  }

  // 分块 + 逐块算纠错
  var layout = blockLayout(version, ecc);
  var blocks = layout.map(function (spec) {
    return { ecLen: spec[0], dataLen: spec[1], data: [], ec: [] };
  });
  var offset = 0;
  blocks.forEach(function (blk) {
    blk.data = dataCodewords.slice(offset, offset + blk.dataLen);
    offset += blk.dataLen;
    blk.ec = rsRemainder(blk.data, rsDivisor(blk.ecLen));
  });

  // 交织：先按列取数据码字，再按列取纠错码字
  var result = [];
  var maxDataLen = 0;
  blocks.forEach(function (blk) { if (blk.data.length > maxDataLen) maxDataLen = blk.data.length; });
  for (var di = 0; di < maxDataLen; di++) {
    blocks.forEach(function (blk) { if (di < blk.data.length) result.push(blk.data[di]); });
  }
  var maxEcLen = blocks.length ? blocks[0].ec.length : 0;
  for (var ei = 0; ei < maxEcLen; ei++) {
    blocks.forEach(function (blk) { result.push(blk.ec[ei]); });
  }
  return { codewords: result, dataCodewords: dataCodewords };
}

// ---------------------------------------------------------------- 矩阵构建
var PENALTY_N1 = 3;
var PENALTY_N2 = 3;
var PENALTY_N3 = 40;
var PENALTY_N4 = 10;

function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

function buildMatrix(version, ecc, codewords, forcedMask) {
  var size = version * 4 + 17;
  var modules = [];
  var isFunction = [];
  var y;
  var x;
  for (y = 0; y < size; y++) {
    var row = [];
    var frow = [];
    for (x = 0; x < size; x++) { row.push(0); frow.push(false); }
    modules.push(row);
    isFunction.push(frow);
  }

  function setFunctionModule(px, py, isDark) {
    modules[py][px] = isDark ? 1 : 0;
    isFunction[py][px] = true;
  }

  function drawFinderPattern(px, py) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = px + dx;
        var yy = py + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  function drawAlignmentPattern(px, py) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        setFunctionModule(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /** 格式信息（15 位 BCH + 固定掩码），写两处 */
  function drawFormatBits(mask) {
    var data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bitsVal = ((data << 10) | rem) ^ 0x5412;

    for (var a = 0; a <= 5; a++) setFunctionModule(8, a, getBit(bitsVal, a));
    setFunctionModule(8, 7, getBit(bitsVal, 6));
    setFunctionModule(8, 8, getBit(bitsVal, 7));
    setFunctionModule(7, 8, getBit(bitsVal, 8));
    for (var b = 9; b < 15; b++) setFunctionModule(14 - b, 8, getBit(bitsVal, b));

    for (var c = 0; c < 8; c++) setFunctionModule(size - 1 - c, 8, getBit(bitsVal, c));
    for (var d = 8; d < 15; d++) setFunctionModule(8, size - 15 + d, getBit(bitsVal, d));
    setFunctionModule(8, size - 8, true);   // 固定的黑模块
  }

  /** 版本信息（18 位 BCH），版本 ≥ 7 才有 */
  function drawVersionBits() {
    if (version < 7) return;
    var rem = version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    var bitsVal = (version << 12) | rem;
    for (var j = 0; j < 18; j++) {
      var bit = getBit(bitsVal, j);
      var a = size - 11 + (j % 3);
      var b = Math.floor(j / 3);
      setFunctionModule(a, b, bit);
      setFunctionModule(b, a, bit);
    }
  }

  function drawFunctionPatterns() {
    for (var i = 0; i < size; i++) {
      setFunctionModule(6, i, i % 2 === 0);   // 竖向定时图形
      setFunctionModule(i, 6, i % 2 === 0);   // 横向定时图形
    }
    drawFinderPattern(3, 3);
    drawFinderPattern(size - 4, 3);
    drawFinderPattern(3, size - 4);

    var pos = alignmentPositions(version);
    var n = pos.length;
    for (var a = 0; a < n; a++) {
      for (var b = 0; b < n; b++) {
        // 三个角上的对齐图形与定位图形重叠，跳过
        if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
        drawAlignmentPattern(pos[a], pos[b]);
      }
    }
    drawFormatBits(0);   // 先占位，掩码确定后会重写
    drawVersionBits();
  }

  /** 之字形填充数据位 */
  function drawCodewords(data) {
    var i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;   // 跳过竖向定时图形所在列
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var xx = right - j;
          var upward = ((right + 1) & 2) === 0;
          var yy = upward ? size - 1 - vert : vert;
          if (!isFunction[yy][xx] && i < data.length * 8) {
            modules[yy][xx] = getBit(data[i >>> 3], 7 - (i & 7)) ? 1 : 0;
            i++;
          }
        }
      }
    }
  }

  function applyMask(mask) {
    for (var py = 0; py < size; py++) {
      for (var px = 0; px < size; px++) {
        var invert;
        switch (mask) {
          case 0: invert = (px + py) % 2 === 0; break;
          case 1: invert = py % 2 === 0; break;
          case 2: invert = px % 3 === 0; break;
          case 3: invert = (px + py) % 3 === 0; break;
          case 4: invert = (Math.floor(px / 3) + Math.floor(py / 2)) % 2 === 0; break;
          case 5: invert = (px * py) % 2 + (px * py) % 3 === 0; break;
          case 6: invert = ((px * py) % 2 + (px * py) % 3) % 2 === 0; break;
          case 7: invert = (((px + py) % 2) + ((px * py) % 3)) % 2 === 0; break;
          default: invert = false;
        }
        if (!isFunction[py][px] && invert) modules[py][px] ^= 1;
      }
    }
  }

  function finderPenaltyAddHistory(runLength, runHistory) {
    if (runHistory[0] === 0) runLength += size;   // 起始的浅色边框
    runHistory.pop();
    runHistory.unshift(runLength);
  }

  function finderPenaltyCountPatterns(runHistory) {
    var n = runHistory[1];
    var core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
      (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  }

  function finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
    if (currentRunColor) {
      finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += size;   // 末尾的浅色边框
    finderPenaltyAddHistory(currentRunLength, runHistory);
    return finderPenaltyCountPatterns(runHistory);
  }

  /** 四条罚分规则，分数越低越"好扫" */
  function penaltyScore() {
    var result = 0;
    var px; var py;

    // 规则 1 + 3：行
    for (py = 0; py < size; py++) {
      var runColor = false;
      var runLen = 0;
      var history = [0, 0, 0, 0, 0, 0, 0];
      for (px = 0; px < size; px++) {
        var dark = modules[py][px] === 1;
        if (dark === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          finderPenaltyAddHistory(runLen, history);
          if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
          runColor = dark;
          runLen = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runLen, history) * PENALTY_N3;
    }

    // 规则 1 + 3：列
    for (px = 0; px < size; px++) {
      var runColorC = false;
      var runLenC = 0;
      var historyC = [0, 0, 0, 0, 0, 0, 0];
      for (py = 0; py < size; py++) {
        var darkC = modules[py][px] === 1;
        if (darkC === runColorC) {
          runLenC++;
          if (runLenC === 5) result += PENALTY_N1;
          else if (runLenC > 5) result++;
        } else {
          finderPenaltyAddHistory(runLenC, historyC);
          if (!runColorC) result += finderPenaltyCountPatterns(historyC) * PENALTY_N3;
          runColorC = darkC;
          runLenC = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColorC, runLenC, historyC) * PENALTY_N3;
    }

    // 规则 2：2×2 同色块
    for (py = 0; py < size - 1; py++) {
      for (px = 0; px < size - 1; px++) {
        var c = modules[py][px];
        if (c === modules[py][px + 1] && c === modules[py + 1][px] && c === modules[py + 1][px + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    // 规则 4：黑白比例失衡
    var darkCount = 0;
    for (py = 0; py < size; py++) {
      for (px = 0; px < size; px++) if (modules[py][px] === 1) darkCount++;
    }
    var total = size * size;
    var k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }

  drawFunctionPatterns();
  drawCodewords(codewords);

  if (forcedMask !== undefined && forcedMask !== null && forcedMask >= 0 && forcedMask <= 7) {
    applyMask(forcedMask);
    drawFormatBits(forcedMask);
    return { size: size, modules: modules, mask: forcedMask };
  }

  var bestMask = 0;
  var minPenalty = Infinity;
  for (var m = 0; m < 8; m++) {
    applyMask(m);
    drawFormatBits(m);
    var penalty = penaltyScore();
    if (penalty < minPenalty) {
      bestMask = m;
      minPenalty = penalty;
    }
    applyMask(m);   // 撤销本次掩码
  }
  applyMask(bestMask);
  drawFormatBits(bestMask);
  return { size: size, modules: modules, mask: bestMask };
}

// ---------------------------------------------------------------- 对外接口
/**
 * 把文本编码为二维码模块矩阵
 * @param {string} text 要编码的内容（如 kcsq://code/CD00000001）
 * @param {object} [opts] { ecc: 'L'|'M'|'Q'|'H'（默认 L）, version: 1-10（可选，默认自动）,
 *                          mask: 0-7（可选，默认自动选最优） }
 * @returns {{text:string, bytes:number, version:number, ecc:string, mask:number,
 *            size:number, modules:number[][], quietZone:number}}
 */
function encode(text, opts) {
  var o = opts || {};
  var ecc = ECC_ORDER.indexOf(o.ecc) >= 0 ? o.ecc : 'L';
  var bytes = utf8Bytes(text);

  var version = Number(o.version || 0);
  if (!version) {
    for (var v = 1; v <= MAX_VERSION; v++) {
      var needBits = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
      if (needBits <= dataCodewordCount(v, ecc) * 8) { version = v; break; }
    }
  }
  if (!version || !RS_BLOCKS[version]) {
    throw new Error('内容过长：' + bytes.length + ' 字节，超出二维码版本 ' + MAX_VERSION +
      '（纠错等级 ' + ecc + '，最多 ' + dataCodewordCount(MAX_VERSION, ecc) + ' 个数据码字）的容量');
  }
  if (4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewordCount(version, ecc) * 8) {
    throw new Error('内容过长：' + bytes.length + ' 字节放不进版本 ' + version + '（纠错等级 ' + ecc + '）');
  }

  var built = buildCodewords(version, ecc, bytes);
  var matrix = buildMatrix(version, ecc, built.codewords, o.mask);
  return {
    text: String(text === undefined || text === null ? '' : text),
    bytes: bytes.length,
    version: version,
    ecc: ecc,
    mask: matrix.mask,
    size: matrix.size,
    modules: matrix.modules,
    quietZone: 4,   // 标准要求四周留 4 个模块的空白
  };
}

/** 字符画（调试 / 自测用）：'#' 黑，' ' 白，带静默区 */
function toText(qr, opts) {
  var o = opts || {};
  var quiet = o.quietZone === undefined ? qr.quietZone : o.quietZone;
  var dark = o.dark || '#';
  var light = o.light || ' ';
  var lines = [];
  var n = qr.size;
  var total = n + quiet * 2;
  for (var y = 0; y < total; y++) {
    var line = '';
    for (var x = 0; x < total; x++) {
      var mx = x - quiet;
      var my = y - quiet;
      var on = mx >= 0 && mx < n && my >= 0 && my < n && qr.modules[my][mx] === 1;
      line += on ? dark : light;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = {
  encode: encode,
  toText: toText,
  // 供自测脚本做表结构/一致性校验
  RS_BLOCKS: RS_BLOCKS,
  ECC_ORDER: ECC_ORDER,
  MAX_VERSION: MAX_VERSION,
  dataCodewordCount: dataCodewordCount,
  totalCodewordCount: totalCodewordCount,
  numRawDataModules: numRawDataModules,
  alignmentPositions: alignmentPositions,
  blockLayout: blockLayout,
  utf8Bytes: utf8Bytes,
};
