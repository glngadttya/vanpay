const QRCode = require('qrcode');

function crc16(buf) {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0x8408;
      else crc >>>= 1;
    }
  }
  return crc & 0xffff;
}

function checksum(payload) {
  const crc = crc16(Buffer.from(payload, 'utf8'));
  return '6304' + crc.toString(16).toUpperCase().padStart(4, '0');
}

function qrToPayload(qrisStr, requireCrc = true) {
  const payload = String(qrisStr || '').trim();
  if (!payload) throw new Error('QRIS kosong');
  if (/^https?:\/\//i.test(payload)) throw new Error('Yang lu kasih URL QRIS, butuh string EMVCo asli (dimulai 000201...)');
  const crcMatch = payload.match(/6304([0-9A-F]{4})$/);
  if (crcMatch) {
    const body = payload.slice(0, -8);
    const expect = crcMatch[1];
    const actual = crc16(Buffer.from(body, 'utf8')).toString(16).toUpperCase().padStart(4, '0');
    if (expect !== actual) throw new Error('CRC16 QRIS tidak valid — string QRIS rusak/typo');
  } else if (requireCrc) {
    throw new Error('Tidak ada segmen CRC (6304) — string QRIS tidak lengkap');
  }
  return payload;
}

function parse(payload) {
  const p = qrToPayload(payload, false);
  const fields = {};
  let i = 0;
  while (i < p.length) {
    const id = p.slice(i, i + 2);
    const len = parseInt(p.slice(i + 2, i + 4), 10);
    if (!/^\d{2}$/.test(id) || Number.isNaN(len)) break;
    const val = p.slice(i + 4, i + 4 + len);
    fields[id] = fields[id] ? (Array.isArray(fields[id]) ? fields[id].concat([val]) : [fields[id], val]) : val;
    i = i + 4 + len;
  }
  return fields;
}

function stripTag(payload, tagId) {
  let out = '';
  let i = 0;
  while (i < payload.length) {
    const id = payload.slice(i, i + 2);
    const len = parseInt(payload.slice(i + 2, i + 4), 10);
    if (!/^\d{2}$/.test(id) || Number.isNaN(len) || len < 0) break;
    if (id !== tagId) out += id + String(len).padStart(2, '0') + payload.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out + payload.slice(i);
}

function buildDynamicQris(staticQris, amount) {
  let payload = qrToPayload(staticQris).replace(/6304[0-9A-F]{4}$/, '');
  payload = stripTag(payload, '53');
  payload = stripTag(payload, '54');

  if (payload.indexOf('010211') >= 0) payload = payload.replace('010211', '010212');

  const amt = String(Math.round(amount) * 100).padStart(12, '0');
  const country = parse(payload)['58'] ? '' : '5802ID';
  const insert = '5303360' + '54' + '12' + amt + country;
  return payload + insert + checksum(payload + insert);
}

async function renderQr(data) {
  const uri = await QRCode.toDataURL(data, { margin: 1, errorCorrectionLevel: 'L', width: 420, color: { dark: '#0b1526', light: '#ffffff' } });
  return uri;
}

module.exports = { crc16, checksum, qrToPayload, parse, stripTag, buildDynamicQris, renderQr };