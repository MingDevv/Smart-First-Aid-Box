import jsQR from 'jsqr';
import QRCode from 'qrcode';
window.SfabQr = { decode: (data, width, height) => jsQR(data, width, height)?.data || null, draw: (canvas, code) => QRCode.toCanvas(canvas, code, { width: 280, margin: 4, errorCorrectionLevel: 'M' }) };
