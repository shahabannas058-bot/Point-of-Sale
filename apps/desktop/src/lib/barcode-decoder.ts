import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import type * as ZXingReader from 'zxing-wasm/reader';

/*
 * zxing-cpp compiled to WebAssembly. The .wasm ships inside the app (Vite copies it next to the build), so camera
 * scanning works offline; by default the library would fetch it from a CDN. The JS is loaded only when a camera
 * scan is first opened, so billing does not pay for it on start-up.
 *
 * A laptop webcam gives small, soft barcodes, so each frame is read one of three ways in turn (see PASSES). Measured
 * on 150 synthetic packets (blur, small bars, upright / sideways / tilted, low contrast): one fixed way read 25,
 * the three in turn read 41, with no wrong codes.
 */

/**
 * Retail and shelf-label codes. ITF and Code 39 are left out on purpose: they carry no check digit, so a blurry
 * webcam frame can produce a wrong number from them.
 */
const FORMATS: ZXingReader.ReadInputBarcodeFormat[] = [
  'EAN13',
  'EAN8',
  'UPCA',
  'UPCE',
  'Code128',
  'QRCode',
];

const BASE: ZXingReader.ReaderOptions = {
  formats: FORMATS,
  tryHarder: true,
  maxNumberOfSymbols: 1,
  // one clean scan line is enough; EAN / UPC / Code 128 check digits still reject misreads
  minLineCount: 1,
};

/** Centre of the frame, matching the guide box drawn over the video. */
const CROP_W = 0.6;
const CROP_H = 0.8;

interface Pass {
  /** 1 = whole frame as is; 2 = the centre crop enlarged twice, which helps small bars */
  zoom: 1 | 2;
  filter: string;
  options: ZXingReader.ReaderOptions;
}

const PASSES: readonly Pass[] = [
  { zoom: 1, filter: 'none', options: { binarizer: 'GlobalHistogram' } },
  { zoom: 2, filter: 'none', options: {} },
  { zoom: 2, filter: 'grayscale(1) contrast(1.8)', options: {} },
];
export const PASS_COUNT = PASSES.length;

/** Frames wider than this are scaled down before the whole-frame pass. */
const MAX_FULL_W = 1280;

type Reader = typeof ZXingReader;
let reader: Promise<Reader> | null = null;

function loadReader(): Promise<Reader> {
  reader ??= import('zxing-wasm/reader')
    .then(async (m) => {
      await m.prepareZXingModule({
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith('.wasm') ? wasmUrl : prefix + path,
        },
        fireImmediately: true,
      });
      return m;
    })
    .catch((e: unknown) => {
      reader = null; // let the next open try again
      throw e;
    });
  return reader;
}

/** Starts loading the decoder early (while the camera warms up). Throws when the .wasm cannot be loaded. */
export async function prepareDecoder(): Promise<void> {
  await loadReader();
}

/** Draws the part of the video a pass looks at; returns its pixels. */
function grab(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, pass: Pass): ImageData {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const canvas = ctx.canvas;
  if (pass.zoom === 1) {
    const scale = Math.min(1, MAX_FULL_W / vw);
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    ctx.filter = pass.filter;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } else {
    const cw = Math.round(vw * CROP_W);
    const ch = Math.round(vh * CROP_H);
    canvas.width = cw * pass.zoom;
    canvas.height = ch * pass.zoom;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = pass.filter;
    ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
  }
  ctx.filter = 'none';
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Reads the current video frame with pass `pass % PASS_COUNT`. Returns the pixels it looked at (for the black
 * picture check) and the text of the first valid barcode, or null.
 */
export async function decodeVideoFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  pass: number,
): Promise<{ frame: ImageData; text: string | null }> {
  const m = await loadReader();
  const p = PASSES[pass % PASS_COUNT] ?? PASSES[0];
  const frame = grab(ctx, video, p as Pass);
  const results = await m.readBarcodes(frame, { ...BASE, ...(p as Pass).options });
  return { frame, text: results.find((r) => r.isValid)?.text ?? null };
}
