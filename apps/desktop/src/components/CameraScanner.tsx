import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CameraOff, Check, X } from 'lucide-react';
import { useT, type TKey } from '../i18n';
import { decodeVideoFrame, prepareDecoder } from '../lib/barcode-decoder';
import {
  cameraProblem,
  DARK_FRAME,
  cleanScan,
  confirmRead,
  frameBrightness,
  type CameraProblem,
  type Candidate,
  trackScan,
  type LastScan,
} from '../lib/barcode-scan';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Select } from './ui/Field';

/** What the screen did with a read, shown under the video (toasts sit behind the open dialog). */
export interface ScanFeedback {
  ok: boolean;
  text: string;
}

/** How often a frame is handed to the decoder. Faster gains little on a laptop webcam and costs CPU. */
const FRAME_MS = 120;
/** A black picture for this long means the camera gives no image (shutter, cover, another app). */
const DARK_AFTER_MS = 2500;
const DEVICE_KEY = 'pos-camera-device';
const PROBLEM_KEY: Record<CameraProblem, TKey> = {
  denied: 'scan.denied',
  missing: 'scan.missing',
  busy: 'scan.busy',
  unsupported: 'scan.unsupported',
  failed: 'scan.failed',
};

const readDevice = (): string => {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveDevice = (id: string): void => {
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    /* private window: the choice is simply not remembered */
  }
};

let audio: AudioContext | null = null;
/** Short scanner-style beep; silent when audio is unavailable. */
function beep(ok: boolean): void {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = ok ? 1800 : 400;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (ok ? 0.08 : 0.2));
  } catch {
    /* no audio device */
  }
}

/**
 * Camera barcode scanner. `continuous` keeps the camera open for the next item (billing); otherwise the dialog
 * closes after the first accepted read (filling a barcode field).
 */
export function CameraScanner({
  open,
  onClose,
  onDetect,
  continuous = false,
}: {
  open: boolean;
  onClose: () => void;
  onDetect: (code: string) => ScanFeedback | Promise<ScanFeedback>;
  continuous?: boolean;
}): ReactNode {
  const t = useT();
  return (
    <Dialog open={open} onClose={onClose} title={t('scan.title')} width={560}>
      <CameraView onDetect={onDetect} onDone={continuous ? undefined : onClose} />
    </Dialog>
  );
}

/** Mounted only while the dialog is open, so unmounting always switches the camera off. */
function CameraView({
  onDetect,
  onDone,
}: {
  onDetect: (code: string) => ScanFeedback | Promise<ScanFeedback>;
  onDone?: () => void;
}): ReactNode {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [deviceId, setDeviceId] = useState(readDevice);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [status, setStatus] = useState<'starting' | 'scanning' | CameraProblem>('starting');
  const [mirror, setMirror] = useState(true);
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [attempt, setAttempt] = useState(0);
  // the browser is waiting for the user to allow the camera (Chrome often shows only an icon in the address bar)
  const [asking, setAsking] = useState(false);
  const [dark, setDark] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  // allowing the camera in the browser's site settings restarts the scanner by itself
  useEffect(() => {
    let perm: PermissionStatus | null = null;
    const onChange = (): void => {
      setAsking(perm?.state === 'prompt');
      if (perm?.state === 'granted' && statusRef.current === 'denied') setAttempt((a) => a + 1);
    };
    navigator.permissions
      ?.query({ name: 'camera' })
      .then((p) => {
        perm = p;
        onChange();
        p.addEventListener('change', onChange);
      })
      .catch(() => undefined); // not every browser knows the 'camera' permission name
    return () => perm?.removeEventListener('change', onChange);
  }, []);

  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let live = true;
    let stream: MediaStream | null = null;
    let timer = 0;
    let last: LastScan | null = null;
    let candidate: Candidate | null = null;
    let pass = 0;
    let darkSince: number | null = null;
    let isDark = false;
    const markDark = (black: boolean, now: number): void => {
      darkSince = black ? (darkSince ?? now) : null;
      const next = darkSince !== null && now - darkSince >= DARK_AFTER_MS;
      if (next !== isDark) {
        isDark = next;
        setDark(next);
      }
    };
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = async (): Promise<void> => {
      const video = videoRef.current;
      if (!live) return;
      const ready = ctx && video && video.readyState >= 2 && video.videoWidth > 0;
      if (!ready) markDark(true, Date.now());
      if (ready) {
        try {
          const { frame, text } = await decodeVideoFrame(ctx, video, pass);
          pass += 1;
          const now = Date.now();
          markDark(frameBrightness(frame.data) < DARK_FRAME, now);
          const code = text === null ? null : cleanScan(text);
          const confirmed = code !== null && confirmRead(candidate, code, now);
          if (confirmed) candidate = confirmed.candidate;
          const seen = confirmed && confirmed.confirmed ? trackScan(last, code, now) : null;
          if (seen) last = seen.last;
          if (live && code !== null && seen?.fresh) {
            const fb = await onDetectRef.current(code);
            if (!live) return;
            beep(fb.ok);
            setFeedback(fb);
            if (fb.ok && onDoneRef.current) {
              onDoneRef.current();
              return;
            }
          }
        } catch {
          // one bad frame is not worth stopping for; a broken decoder shows up in prepareDecoder below
        }
      }
      if (live) timer = window.setTimeout(() => void tick(), FRAME_MS);
    };

    const start = async (): Promise<void> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unsupported');
        return;
      }
      setStatus('starting');
      try {
        const [s] = await Promise.all([
          navigator.mediaDevices.getUserMedia({
            audio: false,
            video: deviceId
              ? { deviceId: { exact: deviceId } }
              : {
                  facingMode: { ideal: 'environment' },
                  // more pixels per bar matters most on a webcam; the camera gives what it can
                  width: { ideal: 1920 },
                  height: { ideal: 1080 },
                },
          }),
          prepareDecoder(),
        ]);
        if (!live) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stream = s;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = s;
        await video.play();
        // cameras with autofocus keep refocusing as the packet comes closer; fixed-focus webcams ignore this
        const track = s.getVideoTracks()[0];
        void track
          ?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
          .catch(() => undefined);
        // a laptop webcam faces the user, so the preview is mirrored like a mirror; a back camera is not
        setMirror(s.getVideoTracks()[0]?.getSettings().facingMode !== 'environment');
        // labels are only filled in once permission is granted
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!live) return;
        setDevices(all.filter((d) => d.kind === 'videoinput'));
        setStatus('scanning');
        void tick();
      } catch (e) {
        if (!live) return;
        // a remembered camera that was unplugged: forget it and fall back to the default one
        if (deviceId && cameraProblem(e) === 'missing') {
          saveDevice('');
          setDeviceId('');
          return;
        }
        setStatus(cameraProblem(e));
      }
    };

    void start();
    return () => {
      live = false;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [deviceId, attempt]);

  const problem = status !== 'starting' && status !== 'scanning' ? status : null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">{t('scan.hint')}</p>
      <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          className={`h-full w-full object-cover ${mirror ? '-scale-x-100' : ''}`}
          aria-label={t('scan.title')}
        />
        {status === 'scanning' ? (
          <div
            className="pointer-events-none absolute inset-x-[12%] top-1/2 h-2/5 -translate-y-1/2 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]"
            aria-hidden="true"
          />
        ) : null}
        {status === 'starting' ? (
          <p
            role="status"
            className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/90"
          >
            {asking ? t('scan.asking') : t('scan.starting')}
          </p>
        ) : null}
        {status === 'scanning' && dark ? (
          <p
            role="alert"
            className="absolute inset-x-0 bottom-0 bg-black/70 p-3 text-center text-sm text-white"
          >
            {t('scan.dark')}
          </p>
        ) : null}
        {problem ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-white">
            <div className="flex flex-col items-center gap-3">
              <CameraOff size={32} aria-hidden="true" />
              <p role="alert" className="text-sm">
                {t(PROBLEM_KEY[problem])}
              </p>
              <Button size="sm" onClick={() => setAttempt((a) => a + 1)}>
                {t('common.retry')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {feedback ? (
        <p
          role="status"
          className={`flex items-center gap-2 text-sm font-semibold ${feedback.ok ? 'text-success' : 'text-danger'}`}
        >
          {feedback.ok ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <X size={16} aria-hidden="true" />
          )}
          {feedback.text}
        </p>
      ) : null}

      {devices.length > 1 ? (
        <label className="field">
          <span className="label">{t('scan.device')}</span>
          <Select
            value={deviceId}
            onChange={(e) => {
              saveDevice(e.target.value);
              setDeviceId(e.target.value);
            }}
          >
            <option value="">{t('scan.defaultDevice')}</option>
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `${t('scan.device')} ${i + 1}`}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
    </div>
  );
}
